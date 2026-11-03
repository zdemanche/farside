import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Finding, Inventory } from "@farside/scan-contracts";
import type { AlertAnalysis } from "./alerts.js";
import type { Contract } from "./billing.js";
import type { BudgetSnapshot } from "./budgets.js";
import { systemClock, type Clock } from "./clock.js";
import type { CommitmentSnapshot } from "./commitments.js";
import type { CostSnapshot } from "./cost.js";
import { combineCosts } from "./cost-total.js";
import type { CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import type { StoredIssue } from "./issues.js";
import { DeletedOrgError, type DeletionRecord } from "./offboard.js";
import {
  applyCommitments,
  applyCost,
  applyCoverage,
  combineCommitments,
  deletionRecordFor,
  dropSubscription,
  emptyOrg,
  pruneScans,
  retagInventories,
  RunningScans,
  sweepRetention,
  type Draft,
} from "./org-ops.js";
import { DEFAULT_CLOUD, providerFor } from "./providers/index.js";
import {
  MAX_SCANS_PER_ORG,
  type AggregateName,
  type Connection,
  type ConnectionInput,
  type OrgRepository,
  type OrgState,
  type OrgView,
  type ScanPage,
  type Sequence,
} from "./repository.js";
import type { ScanJob } from "./scans.js";
import { emptySchedule, type ScheduleState } from "./scheduler.js";
import { assertNoSecrets, markVerified } from "./secrets.js";
import type { OrgSettings } from "./settings.js";
import { DEFAULT_SETTINGS } from "./settings.js";

export const ORG_INDEX = "gsi1";
export const INLINE_BYTES = 300_000;
export const CHUNK_UNITS = 100_000;

const ORG_PREFIX = "ORG#";
const ORG_LISTING = "ORGS";
const MAX_VERSION_RETRIES = 8;
const BATCH_SIZE = 25;
const SK = {
  meta: "META",
  seq: "SEQ",
  deletion: "DELETION",
  coverage: "COV",
  findings: "FINDINGS",
  facts: "FACTS",
  issues: "ISSUES",
  settings: "SETTINGS",
  contract: "CONTRACT",
  budgets: "BUDGETS",
  alerts: "ALERTS",
  schedule: "SCHEDULE",
} as const;
const PREFIX = { connection: "CONN#", inventory: "INV#", cost: "COST#", commitment: "COMMIT#", scan: "SCAN#" } as const;
const CHUNK_PREFIX = "CHUNK#";

type Item = Record<string, unknown>;
type Header = { sk: string; version: number; body?: string; gen?: string; parts?: number };
type Stored<T> = { value: T; version: number };
type PutOptions = { expected?: number; extra?: Item };

type Persistent = Exclude<AggregateName, "cost" | "commitments" | "inventory">;
type Codec = {
  load: (orgId: string) => Promise<unknown>;
  entries: (value: never) => Map<string, unknown>;
};

const PERSISTENT: Persistent[] = [
  "connections",
  "inventories",
  "coverage",
  "findings",
  "settings",
  "scans",
  "facts",
  "issues",
  "costs",
  "commitmentsBySubscription",
  "budgets",
  "alerts",
  "schedule",
  "contract",
];

const BACKING: Partial<Record<AggregateName, Persistent[]>> = {
  cost: ["costs"],
  commitments: ["commitmentsBySubscription"],
  inventory: ["inventories"],
};

const SUBSCRIPTION_KEYS: AggregateName[] = [
  "connections",
  "inventories",
  "inventory",
  "facts",
  "cost",
  "costs",
  "commitments",
  "commitmentsBySubscription",
  "findings",
  "coverage",
  "issues",
];

const pad = (value: number, width = 10) => String(value).padStart(width, "0");

function sequenceOf(id: string): number {
  const parsed = Number(id.slice(id.lastIndexOf("-") + 1));
  if (!Number.isInteger(parsed)) {
    throw new Error(`unsupported id ${id}`);
  }
  return parsed;
}

const connectionSk = (id: string) => `${PREFIX.connection}${pad(sequenceOf(id))}`;
const scanSk = (id: string) => `${PREFIX.scan}${pad(sequenceOf(id))}`;
const chunkSk = (sk: string, gen: string, index: number) => `${CHUNK_PREFIX}${sk}#${gen}#${pad(index, 5)}`;
const orgKey = (orgId: string) => `${ORG_PREFIX}${orgId}`;

function splitJson(json: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < json.length) {
    let end = Math.min(start + CHUNK_UNITS, json.length);
    const last = json.charCodeAt(end - 1);
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    parts.push(json.slice(start, end));
    start = end;
  }
  return parts;
}

export function documentClient(client: DynamoDBClient = new DynamoDBClient({})): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export class DynamoStore implements OrgRepository {
  #running = new RunningScans();
  #known = new Set<string>();
  #deleted = new Map<string, DeletionRecord>();
  #codecs: Record<Persistent, Codec>;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    readonly clock: Clock = systemClock,
  ) {
    const single = <V>(sk: string, empty: () => V): Codec => ({
      load: async (orgId) => (await this.#getDoc<V>(orgId, sk))?.value ?? empty(),
      entries: (value: V) => (value === null || value === undefined ? new Map() : new Map([[sk, value]])),
    });
    const keyed = <V>(
      prefix: string,
      toPairs: (value: V) => [string, unknown][],
      fromPairs: (pairs: [string, unknown][]) => V,
    ): Codec => ({
      load: async (orgId) =>
        fromPairs(
          [...(await this.#listDocs(orgId, prefix))].map(([sk, { value }]) => [sk.slice(prefix.length), value]),
        ),
      entries: (value: V) => new Map(toPairs(value).map(([key, item]) => [`${prefix}${key}`, item])),
    });
    const record = <V>(prefix: string) =>
      keyed<Record<string, V>>(
        prefix,
        (value) => Object.entries(value),
        (pairs) => Object.fromEntries(pairs) as Record<string, V>,
      );
    const list = <V extends { id: string }>(prefix: string, skOf: (id: string) => string) =>
      keyed<V[]>(
        prefix,
        (value) => value.map((item) => [skOf(item.id).slice(prefix.length), item]),
        (pairs) => pairs.sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item as V),
      );
    this.#codecs = {
      connections: list<Connection>(PREFIX.connection, connectionSk),
      inventories: record<Inventory>(PREFIX.inventory),
      coverage: single<CoverageEntry[]>(SK.coverage, () => []),
      findings: single<Finding[]>(SK.findings, () => []),
      settings: single<OrgSettings>(SK.settings, () => ({ ...DEFAULT_SETTINGS, updatedAt: this.clock() })),
      scans: list<ScanJob>(PREFIX.scan, scanSk),
      facts: single<ResourceFacts[]>(SK.facts, () => []),
      issues: single<StoredIssue[]>(SK.issues, () => []),
      costs: record<CostSnapshot>(PREFIX.cost),
      commitmentsBySubscription: record<CommitmentSnapshot>(PREFIX.commitment),
      budgets: single<BudgetSnapshot | null>(SK.budgets, () => null),
      alerts: single<AlertAnalysis | null>(SK.alerts, () => null),
      schedule: single<ScheduleState>(SK.schedule, emptySchedule),
      contract: single<Contract | null>(SK.contract, () => null),
    };
  }

  async #query(
    orgId: string,
    options: {
      prefix?: string;
      index?: boolean;
      projection?: string;
      names?: Record<string, string>;
      limit?: number;
      startKey?: Item;
      count?: boolean;
    } = {},
  ): Promise<{ items: Item[]; count: number; lastKey: Item | undefined }> {
    const items: Item[] = [];
    let count = 0;
    let startKey = options.startKey;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          ...(options.index ? { IndexName: ORG_INDEX } : { ConsistentRead: true }),
          KeyConditionExpression: options.index
            ? "gsi1pk = :pk"
            : options.prefix === undefined
              ? "pk = :pk"
              : "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": options.index ? ORG_LISTING : orgKey(orgId),
            ...(options.prefix === undefined || options.index ? {} : { ":prefix": options.prefix }),
          },
          ...(options.projection ? { ProjectionExpression: options.projection } : {}),
          ...(options.names ? { ExpressionAttributeNames: options.names } : {}),
          ...(options.count ? { Select: "COUNT" } : {}),
          ...(options.limit === undefined ? {} : { Limit: options.limit }),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      items.push(...((result.Items ?? []) as Item[]));
      count += result.Count ?? 0;
      startKey = result.LastEvaluatedKey as Item | undefined;
      if (options.limit !== undefined) {
        return { items, count, lastKey: startKey };
      }
    } while (startKey);
    return { items, count, lastKey: undefined };
  }

  async #resolve<T>(orgId: string, header: Header): Promise<T> {
    if (header.body !== undefined) {
      return JSON.parse(header.body) as T;
    }
    const { items } = await this.#query(orgId, { prefix: `${CHUNK_PREFIX}${header.sk}#${header.gen}#` });
    if (items.length !== header.parts) {
      throw new Error(`document ${header.sk} is missing chunks`);
    }
    return JSON.parse(items.map((item) => item.body as string).join("")) as T;
  }

  async #getDoc<T>(orgId: string, sk: string): Promise<Stored<T> | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { pk: orgKey(orgId), sk }, ConsistentRead: true }),
    );
    const header = result.Item as Header | undefined;
    return header ? { value: await this.#resolve<T>(orgId, header), version: header.version } : undefined;
  }

  async #listDocs(orgId: string, prefix: string): Promise<Map<string, Stored<unknown>>> {
    const { items } = await this.#query(orgId, { prefix });
    const resolved = await Promise.all(
      (items as Header[]).map(
        async (header) => [header.sk, { value: await this.#resolve<unknown>(orgId, header), version: header.version }] as const,
      ),
    );
    return new Map(resolved);
  }

  async #putDoc(orgId: string, sk: string, value: unknown, options: PutOptions = {}): Promise<void> {
    const pk = orgKey(orgId);
    const json = JSON.stringify(value);
    const parts = Buffer.byteLength(json) <= INLINE_BYTES ? [] : splitJson(json);
    const gen = parts.length > 0 ? randomUUID() : undefined;
    if (gen) {
      await Promise.all(
        parts.map((body, index) =>
          this.client.send(new PutCommand({ TableName: this.table, Item: { pk, sk: chunkSk(sk, gen, index), body } })),
        ),
      );
    }
    const expected = options.expected;
    try {
      const result = await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk,
            sk,
            version: (expected ?? 0) + 1,
            ...(gen ? { gen, parts: parts.length } : { body: json }),
            ...options.extra,
          },
          ReturnValues: "ALL_OLD",
          ...(expected === undefined
            ? {}
            : expected === 0
              ? { ConditionExpression: "attribute_not_exists(pk)" }
              : {
                  ConditionExpression: "#version = :expected",
                  ExpressionAttributeNames: { "#version": "version" },
                  ExpressionAttributeValues: { ":expected": expected },
                }),
        }),
      );
      await this.#dropChunks(pk, sk, result.Attributes as Header | undefined);
    } catch (error) {
      if (gen) {
        await this.#dropChunks(pk, sk, { sk, version: 0, gen, parts: parts.length });
      }
      throw error;
    }
  }

  async #dropChunks(pk: string, sk: string, old: Header | undefined): Promise<void> {
    if (!old?.gen) {
      return;
    }
    const { gen } = old;
    await Promise.all(
      Array.from({ length: old.parts ?? 0 }, (_, index) =>
        this.client.send(new DeleteCommand({ TableName: this.table, Key: { pk, sk: chunkSk(sk, gen, index) } })),
      ),
    );
  }

  async #delDoc(orgId: string, sk: string): Promise<void> {
    const pk = orgKey(orgId);
    const result = await this.client.send(
      new DeleteCommand({ TableName: this.table, Key: { pk, sk }, ReturnValues: "ALL_OLD" }),
    );
    await this.#dropChunks(pk, sk, result.Attributes as Header | undefined);
  }

  async deletion(orgId: string): Promise<DeletionRecord | null> {
    const cached = this.#deleted.get(orgId);
    if (cached) {
      return cached;
    }
    const stored = await this.#getDoc<DeletionRecord>(orgId, SK.deletion);
    if (stored) {
      this.#deleted.set(orgId, stored.value);
    }
    return stored?.value ?? null;
  }

  async #assertLive(orgId: string): Promise<void> {
    if (await this.deletion(orgId)) {
      throw new DeletedOrgError(orgId);
    }
  }

  async #touch(orgId: string): Promise<void> {
    await this.#assertLive(orgId);
    if (this.#known.has(orgId)) {
      return;
    }
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: orgKey(orgId), sk: SK.meta, gsi1pk: ORG_LISTING, gsi1sk: orgKey(orgId) },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
    this.#known.add(orgId);
  }

  async #load(orgId: string, keys: readonly AggregateName[]): Promise<Partial<OrgState>> {
    const persistent = [...new Set(keys.flatMap((key) => BACKING[key] ?? [key as Persistent]))];
    const [, latest, ...values] = await Promise.all([
      this.#assertLive(orgId),
      keys.includes("inventory") ? this.#latestInventoryCloud(orgId) : undefined,
      ...persistent.map((key) => this.#codecs[key].load(orgId)),
    ]);
    const loaded: Record<string, unknown> = Object.fromEntries(persistent.map((key, index) => [key, values[index]]));
    if (keys.includes("cost")) {
      loaded.cost = combineCosts(Object.values(loaded.costs as Record<string, CostSnapshot>));
    }
    if (keys.includes("commitments")) {
      loaded.commitments = combineCommitments(
        Object.values(loaded.commitmentsBySubscription as Record<string, CommitmentSnapshot>),
      );
    }
    if (keys.includes("inventory")) {
      loaded.inventory = latest ? ((loaded.inventories as Record<string, Inventory>)[latest as string] ?? null) : null;
    }
    return loaded as Partial<OrgState>;
  }

  async #latestInventoryCloud(orgId: string): Promise<string | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { pk: orgKey(orgId), sk: SK.meta }, ConsistentRead: true }),
    );
    return (result.Item as { latestInventory?: string } | undefined)?.latestInventory;
  }

  async read<K extends AggregateName>(orgId: string, ...keys: K[]): Promise<Pick<OrgView, K>> {
    const loaded = await this.#load(orgId, keys);
    return Object.fromEntries(keys.map((key) => [key, loaded[key]])) as Pick<OrgView, K>;
  }

  async #mutate<K extends AggregateName>(
    orgId: string,
    keys: readonly K[],
    change: (draft: Draft<K>) => void,
  ): Promise<Draft<K>> {
    const draft = (await this.#load(orgId, keys)) as Draft<K>;
    const persistent = [...new Set(keys.flatMap((key) => BACKING[key] ?? [key as Persistent]))];
    const serialise = (key: Persistent) =>
      new Map(
        [...this.#codecs[key].entries(((draft as unknown as Record<string, unknown>)[key] as never))].map(
          ([sk, value]) => [sk, JSON.stringify(value)] as const,
        ),
      );
    const before = new Map(persistent.map((key) => [key, serialise(key)] as const));
    change(draft);
    await this.#touch(orgId);
    for (const key of persistent) {
      const prior = before.get(key) ?? new Map<string, string>();
      const next = this.#codecs[key].entries(((draft as unknown as Record<string, unknown>)[key] as never));
      for (const [sk, value] of next) {
        if (prior.get(sk) !== JSON.stringify(value)) {
          await this.#putDoc(orgId, sk, value);
        }
      }
      for (const sk of prior.keys()) {
        if (!next.has(sk)) {
          await this.#delDoc(orgId, sk);
        }
      }
    }
    return draft;
  }

  async hasOrg(orgId: string): Promise<boolean> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { pk: orgKey(orgId), sk: SK.meta }, ConsistentRead: true }),
    );
    return result.Item !== undefined;
  }

  async orgIds(): Promise<string[]> {
    const { items } = await this.#query("", { index: true });
    return items.map((item) => (item.pk as string).slice(ORG_PREFIX.length));
  }

  trackScan(orgId: string): { signal: AbortSignal; release: () => void } {
    return this.#running.track(orgId);
  }

  async nextSequence(orgId: string, kind: Sequence): Promise<number> {
    await this.#touch(orgId);
    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: orgKey(orgId), sk: SK.seq },
        UpdateExpression: "ADD #kind :one",
        ExpressionAttributeNames: { "#kind": kind },
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return (result.Attributes as Record<Sequence, number>)[kind];
  }

  async putConnection(orgId: string, input: ConnectionInput): Promise<Connection> {
    assertNoSecrets(input);
    const cloud = input.cloud ?? DEFAULT_CLOUD;
    const connection: Connection = {
      id: `conn-${await this.nextSequence(orgId, "connection")}`,
      cloud,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      roles: [...providerFor(cloud).requiredRoles],
      createdAt: this.clock(),
      healthy: true,
    };
    markVerified(connection);
    await this.#putDoc(orgId, connectionSk(connection.id), connection);
    return connection;
  }

  async patchConnection(
    orgId: string,
    connectionId: string,
    patch: { healthy: boolean },
  ): Promise<Connection | null> {
    let patched: Connection | null = null;
    await this.#mutate(orgId, ["connections"], (draft) => {
      patched = draft.connections.find((item) => item.id === connectionId) ?? null;
      if (patched) {
        patched.healthy = patch.healthy;
        assertNoSecrets(patched);
        markVerified(patched);
      }
    });
    return patched;
  }

  async deleteConnection(orgId: string, connectionId: string): Promise<boolean> {
    const { connections } = await this.read(orgId, "connections");
    const removed = connections.find((connection) => connection.id === connectionId);
    if (!removed) {
      return false;
    }
    const target = removed.subscriptionId.toLowerCase();
    const shared = connections.some(
      (connection) => connection.id !== connectionId && connection.subscriptionId.toLowerCase() === target,
    );
    await this.#mutate(orgId, shared ? ["connections"] : SUBSCRIPTION_KEYS, (draft) => {
      draft.connections = draft.connections.filter((connection) => connection.id !== connectionId);
      if (!shared) {
        dropSubscription(draft, removed.subscriptionId);
      }
    });
    return true;
  }

  async isConnected(orgId: string, subscriptionId: string): Promise<boolean> {
    const target = subscriptionId.toLowerCase();
    const { connections } = await this.read(orgId, "connections");
    return connections.some((item) => item.subscriptionId.toLowerCase() === target);
  }

  async #replace<T extends object | null>(orgId: string, sk: string, value: T): Promise<T> {
    await this.#touch(orgId);
    if (value === null) {
      await this.#delDoc(orgId, sk);
    } else {
      await this.#putDoc(orgId, sk, value);
    }
    return value;
  }

  async putInventory(orgId: string, inventory: Inventory): Promise<Inventory> {
    assertNoSecrets(inventory);
    markVerified(inventory);
    await this.#touch(orgId);
    await this.#putDoc(orgId, `${PREFIX.inventory}${inventory.cloud}`, inventory);
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: orgKey(orgId), sk: SK.meta },
        UpdateExpression: "SET latestInventory = :cloud",
        ExpressionAttributeValues: { ":cloud": inventory.cloud },
      }),
    );
    return inventory;
  }

  async putCoverage(orgId: string, coverage: CoverageEntry[]): Promise<CoverageEntry[]> {
    assertNoSecrets(coverage);
    const draft = await this.#mutate(orgId, ["cost", "costs", "coverage"], (state) => applyCoverage(state, coverage));
    return draft.coverage;
  }

  async putFindings(orgId: string, findings: Finding[]): Promise<Finding[]> {
    assertNoSecrets(findings);
    return await this.#replace(orgId, SK.findings, findings);
  }

  async putFacts(orgId: string, facts: ResourceFacts[]): Promise<ResourceFacts[]> {
    assertNoSecrets(facts);
    return await this.#replace(orgId, SK.facts, facts);
  }

  async putIssues(orgId: string, issues: StoredIssue[]): Promise<StoredIssue[]> {
    assertNoSecrets(issues);
    return await this.#replace(orgId, SK.issues, issues);
  }

  async putCost(
    orgId: string,
    cost: CostSnapshot | null,
    subscriptionId: string | undefined = cost?.subscriptionId,
  ): Promise<CostSnapshot | null> {
    if (cost) {
      assertNoSecrets(cost);
    }
    await this.#mutate(orgId, ["cost", "costs", "coverage"], (state) => applyCost(state, cost, subscriptionId));
    return cost;
  }

  async putCommitments(
    orgId: string,
    commitments: CommitmentSnapshot | null,
    subscriptionId: string | undefined = commitments?.subscriptionId,
  ): Promise<CommitmentSnapshot | null> {
    if (commitments) {
      assertNoSecrets(commitments);
    }
    await this.#mutate(orgId, ["commitments", "commitmentsBySubscription"], (state) =>
      applyCommitments(state, commitments, subscriptionId),
    );
    return commitments;
  }

  async putBudgets(orgId: string, budgets: BudgetSnapshot | null): Promise<BudgetSnapshot | null> {
    if (budgets) {
      assertNoSecrets(budgets);
    }
    return await this.#replace(orgId, SK.budgets, budgets);
  }

  async putAlerts(orgId: string, alerts: AlertAnalysis | null): Promise<AlertAnalysis | null> {
    if (alerts) {
      assertNoSecrets(alerts);
    }
    return await this.#replace(orgId, SK.alerts, alerts);
  }

  async putContract(orgId: string, contract: Contract | null): Promise<Contract | null> {
    if (contract) {
      assertNoSecrets(contract);
    }
    return await this.#replace(orgId, SK.contract, contract);
  }

  async putSettings(orgId: string, settings: OrgSettings): Promise<OrgSettings> {
    assertNoSecrets(settings);
    await this.#mutate(orgId, ["settings", "inventories", "inventory"], (state) => {
      state.settings = settings;
      retagInventories(state, settings.ownerTagKey);
    });
    return settings;
  }

  async updateSchedule(orgId: string, mutate: (schedule: ScheduleState) => void): Promise<ScheduleState> {
    await this.#touch(orgId);
    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt += 1) {
      const current = await this.#getDoc<ScheduleState>(orgId, SK.schedule);
      const next = current?.value ?? emptySchedule();
      mutate(next);
      try {
        await this.#putDoc(orgId, SK.schedule, next, { expected: current?.version ?? 0 });
        return next;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }
      }
    }
    throw new Error(`schedule for ${orgId} changed concurrently`);
  }

  async putJob(input: Omit<ScanJob, "id">): Promise<ScanJob> {
    assertNoSecrets(input);
    const sequence = await this.nextSequence(input.orgId, "scan");
    const job: ScanJob = { ...input, id: `scan-${sequence}` };
    markVerified(job);
    await this.#putDoc(input.orgId, scanSk(job.id), job, { ...scanOptions(job), expected: 0 });
    if (sequence > MAX_SCANS_PER_ORG) {
      await this.#pruneScans(input.orgId);
    }
    return job;
  }

  async #pruneScans(orgId: string): Promise<void> {
    const total = await this.#query(orgId, { prefix: PREFIX.scan, count: true });
    if (total.count <= MAX_SCANS_PER_ORG) {
      return;
    }
    const { items } = await this.#query(orgId, {
      prefix: PREFIX.scan,
      projection: "sk, #status, #complete",
      names: { "#status": "status", "#complete": "complete" },
    });
    const rows = items as { sk: string; status: string; complete: boolean }[];
    const kept = new Set(pruneScans(rows));
    for (const row of rows) {
      if (!kept.has(row)) {
        await this.#delDoc(orgId, row.sk);
      }
    }
  }

  async getJob(orgId: string, jobId: string): Promise<ScanJob | undefined> {
    const [stored] = await Promise.all([
      this.#getDoc<ScanJob>(orgId, scanSk(jobId)),
      this.#assertLive(orgId),
    ]);
    return stored?.value ? markVerified(stored.value) : undefined;
  }

  async patchJob(orgId: string, jobId: string, patch: Partial<ScanJob>): Promise<ScanJob> {
    await this.#touch(orgId);
    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt += 1) {
      const current = await this.#getDoc<ScanJob>(orgId, scanSk(jobId));
      if (!current) {
        throw new Error(`scan ${jobId} missing`);
      }
      const next = { ...current.value, ...patch, id: current.value.id, orgId: current.value.orgId };
      assertNoSecrets(next);
      markVerified(next);
      try {
        await this.#putDoc(orgId, scanSk(jobId), next, { ...scanOptions(next), expected: current.version });
        return next;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }
      }
    }
    throw new Error(`scan ${jobId} changed concurrently`);
  }

  async runningScan(orgId: string, subscriptionId: string): Promise<ScanJob | undefined> {
    const { scans } = await this.read(orgId, "scans");
    return scans.find(
      (job) =>
        job.subscriptionId === subscriptionId && (job.status === "queued" || job.status === "running"),
    ) as ScanJob | undefined;
  }

  async listScans(orgId: string, page: { limit?: number; after?: string } = {}): Promise<ScanPage> {
    const limit = page.limit ?? MAX_SCANS_PER_ORG;
    const [{ items, lastKey }] = await Promise.all([
      this.#query(orgId, {
        prefix: PREFIX.scan,
        limit,
        ...(page.after === undefined ? {} : { startKey: { pk: orgKey(orgId), sk: scanSk(page.after) } }),
      }),
      this.#assertLive(orgId),
    ]);
    const scans = await Promise.all(
      (items as Header[]).map(async (header) => markVerified(await this.#resolve<ScanJob>(orgId, header))),
    );
    const last = scans.at(-1);
    return lastKey && last ? { scans, next: last.id } : { scans };
  }

  async offboard(
    orgId: string,
    now: string = this.clock(),
    trigger: DeletionRecord["trigger"] = "customer",
    requestedBy: string = trigger === "retention" ? "system" : "unknown",
  ): Promise<DeletionRecord> {
    const existing = await this.deletion(orgId);
    if (existing) {
      await this.#purge(orgId);
      return existing;
    }
    const org = (await this.hasOrg(orgId))
      ? ({
          ...emptyOrg(now),
          ...(await this.#load(orgId, [...PERSISTENT, "inventory", "cost", "commitments"])),
        } as OrgState)
      : undefined;
    const record = deletionRecordFor(org, {
      orgId,
      now,
      trigger,
      requestedBy,
      runningScans: this.#running.abortAll(orgId),
    });
    assertNoSecrets(record);
    try {
      await this.#putDoc(orgId, SK.deletion, record, { expected: 0 });
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return (await this.deletion(orgId)) ?? record;
      }
      throw error;
    }
    this.#deleted.set(orgId, record);
    this.#known.delete(orgId);
    await this.#purge(orgId);
    return record;
  }

  async #purge(orgId: string): Promise<void> {
    const { items } = await this.#query(orgId, { projection: "sk" });
    const keys = items.map((item) => item.sk as string).filter((sk) => sk !== SK.deletion);
    for (let start = 0; start < keys.length; start += BATCH_SIZE) {
      let pending: Record<string, unknown>[] = keys
        .slice(start, start + BATCH_SIZE)
        .map((sk) => ({ DeleteRequest: { Key: { pk: orgKey(orgId), sk } } }));
      for (let attempt = 0; pending.length > 0 && attempt < MAX_VERSION_RETRIES; attempt += 1) {
        const result = await this.client.send(
          new BatchWriteCommand({ RequestItems: { [this.table]: pending as never } }),
        );
        pending = (result.UnprocessedItems?.[this.table] ?? []) as Record<string, unknown>[];
      }
      if (pending.length > 0) {
        throw new Error(`could not purge all items for ${orgId}`);
      }
    }
  }

  sweepRetention(now: string = this.clock(), onlyOrgId?: string): Promise<DeletionRecord[]> {
    return sweepRetention(this, now, onlyOrgId);
  }
}

function scanOptions(job: ScanJob): PutOptions {
  return { extra: { status: job.status, complete: job.complete } };
}
