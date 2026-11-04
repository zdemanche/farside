import { createHash, randomUUID } from "node:crypto";
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteItem,
} from "@aws-sdk/lib-dynamodb";
import type { Cloud, Finding, Inventory } from "@farside/scan-contracts";
import type { BlobStore } from "./blob-store.js";
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
import { DEFAULT_CLOUD } from "./providers/index.js";
import { presentRoles, probeRoles } from "./role-probe.js";
import {
  MAX_SCANS_PER_ORG,
  type AggregateName,
  type Connection,
  type ConnectionInput,
  type ConnectionPatch,
  type OrgRepository,
  type OrgState,
  type OrgView,
  type ScanMergeDraft,
  type Sequence,
} from "./repository.js";
import type { ScanJob } from "./scans.js";
import { emptySchedule, type ScheduleState } from "./scheduler.js";
import { assertNoSecrets, markVerified } from "./secrets.js";
import { silentLog, type LogSink } from "./observability.js";
import type { OrgSettings } from "./settings.js";
import { DEFAULT_SETTINGS } from "./settings.js";

export const ORG_INDEX = "gsi1";
export const INLINE_BYTES = 300_000;

const ORG_PREFIX = "ORG#";
const ORG_LISTING = "ORGS";
const DELETED_LISTING = "DELETED";
const REPURGE_MS = 48 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 12;
const SEQ_ATTEMPTS = 40;
const BACKOFF_BASE_MS = 20;
const BACKOFF_CAP_MS = 1_000;
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
  seeded: "SEEDED",
} as const;
const PREFIX = { connection: "CONN#", inventory: "INV#", cost: "COST#", commitment: "COMMIT#", scan: "SCAN#" } as const;

type Item = Record<string, unknown>;
type Header = {
  sk: string;
  version: number;
  body?: string;
  blobKey?: string;
  sha256?: string;
  size?: number;
};
type Stored<T> = { value: T; version: number };
type PutOptions = { expected?: number; extra?: Item };

type Persistent = Exclude<AggregateName, "cost" | "commitments" | "inventory">;
type Loaded = { value: unknown; versions: Map<string, number> };
type Codec = {
  load: (orgId: string) => Promise<Loaded>;
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
const entityOf = (sk: string) => sk.split("#")[0] as string;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function backoff(attempt: number): Promise<void> {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}
const orgKey = (orgId: string) => `${ORG_PREFIX}${orgId}`;

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
    private readonly blobs: BlobStore,
    readonly clock: Clock = systemClock,
    private readonly log: LogSink = silentLog,
  ) {
    const single = <V>(sk: string, empty: () => V): Codec => ({
      load: async (orgId) => {
        const stored = await this.#getDoc<V>(orgId, sk);
        return { value: stored?.value ?? empty(), versions: new Map(stored ? [[sk, stored.version]] : []) };
      },
      entries: (value: V) => (value === null || value === undefined ? new Map() : new Map([[sk, value]])),
    });
    const keyed = <V>(
      prefix: string,
      toPairs: (value: V) => [string, unknown][],
      fromPairs: (pairs: [string, unknown][]) => V,
    ): Codec => ({
      load: async (orgId) => {
        const docs = await this.#listDocs(orgId, prefix);
        return {
          value: fromPairs([...docs].map(([sk, { value }]) => [sk.slice(prefix.length), value])),
          versions: new Map([...docs].map(([sk, { version }]) => [sk, version])),
        };
      },
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
      indexPk?: string;
      skFrom?: string;
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
            ? options.skFrom === undefined
              ? "gsi1pk = :pk"
              : "gsi1pk = :pk AND gsi1sk >= :from"
            : options.prefix === undefined
              ? "pk = :pk"
              : "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": options.index ? (options.indexPk ?? ORG_LISTING) : orgKey(orgId),
            ...(options.prefix === undefined || options.index ? {} : { ":prefix": options.prefix }),
            ...(options.skFrom === undefined ? {} : { ":from": options.skFrom }),
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
    const first = await this.#fetchBlob(header);
    if (first !== undefined) {
      return JSON.parse(first) as T;
    }
    const again = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { pk: orgKey(orgId), sk: header.sk }, ConsistentRead: true }),
    );
    const current = again.Item as Header | undefined;
    if (current?.body !== undefined) {
      return JSON.parse(current.body) as T;
    }
    const second = current ? await this.#fetchBlob(current) : undefined;
    if (second === undefined) {
      throw new Error(`document ${header.sk} of ${orgId} points at a missing or changed blob`);
    }
    return JSON.parse(second) as T;
  }

  async #fetchBlob(header: Header): Promise<string | undefined> {
    const text = header.blobKey ? await this.blobs.get(header.blobKey) : undefined;
    return text !== undefined && sha256(text) === header.sha256 ? text : undefined;
  }

  async #dropBlob(key: string | undefined, keep?: string): Promise<void> {
    if (!key || key === keep) {
      return;
    }
    try {
      await this.blobs.delete(key);
    } catch (error) {
      this.log.error({ err: error, blobKey: key }, "could not delete a superseded blob; offboard will sweep it");
    }
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

  async #writeLive(orgId: string, write: TransactWriteItem, live = true): Promise<void> {
    const TransactItems = live
      ? [
          {
            ConditionCheck: {
              TableName: this.table,
              Key: { pk: orgKey(orgId), sk: SK.deletion },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          write,
        ]
      : [write];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems }));
        return;
      } catch (error) {
        const reasons =
          error instanceof TransactionCanceledException
            ? (error.CancellationReasons ?? [])
            : typeof error === "object" && error !== null && "CancellationReasons" in error
              ? ((error as TransactionCanceledException).CancellationReasons ?? [])
              : undefined;
        if (reasons) {
          if (live && reasons[0]?.Code === "ConditionalCheckFailed") {
            throw new DeletedOrgError(orgId);
          }
          if (reasons[live ? 1 : 0]?.Code === "ConditionalCheckFailed") {
            throw new ConditionalCheckFailedException({
              message: error instanceof Error ? error.message : "The conditional request failed",
              $metadata: error instanceof TransactionCanceledException ? error.$metadata : { httpStatusCode: 400 },
            });
          }
          if (reasons.some((reason) => reason.Code === "TransactionConflict")) {
            await backoff(attempt);
            continue;
          }
        }
        throw error;
      }
    }
    throw new Error(`transaction for ${orgId} conflicted after ${MAX_ATTEMPTS} attempts`);
  }

  async #putDoc(orgId: string, sk: string, value: unknown, options: PutOptions = {}): Promise<void> {
    const pk = orgKey(orgId);
    const json = JSON.stringify(value);
    const big = Buffer.byteLength(json) > INLINE_BYTES;
    const blobKey = big ? `${pk}/${sk}/${randomUUID()}.json` : undefined;
    if (blobKey) {
      await this.blobs.put(blobKey, json);
    }
    const names: Record<string, string> = {
      "#version": "version",
      "#body": "body",
      "#blobKey": "blobKey",
      "#sha256": "sha256",
      "#size": "size",
      "#entityType": "entityType",
    };
    const values: Record<string, unknown> = { ":one": 1, ":entityType": entityOf(sk) };
    const sets = ["#entityType = :entityType"];
    const removes: string[] = [];
    if (blobKey) {
      sets.push("#blobKey = :blobKey", "#sha256 = :sha256", "#size = :size");
      removes.push("#body");
      values[":blobKey"] = blobKey;
      values[":sha256"] = sha256(json);
      values[":size"] = Buffer.byteLength(json);
    } else {
      sets.push("#body = :body");
      removes.push("#blobKey", "#sha256", "#size");
      values[":body"] = json;
    }
    Object.entries(options.extra ?? {}).forEach(([name, extra], index) => {
      names[`#x${index}`] = name;
      values[`:x${index}`] = extra;
      sets.push(`#x${index} = :x${index}`);
    });
    const expected = options.expected;
    if (expected !== undefined && expected !== 0) {
      values[":expected"] = expected;
    }
    const previous =
      expected === 0
        ? undefined
        : ((
            await this.client.send(
              new GetCommand({ TableName: this.table, Key: { pk, sk }, ConsistentRead: true }),
            )
          ).Item as Header | undefined);
    try {
      await this.#writeLive(
        orgId,
        {
          Update: {
            TableName: this.table,
            Key: { pk, sk },
            UpdateExpression: `SET ${sets.join(", ")} REMOVE ${removes.join(", ")} ADD #version :one`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ...(expected === undefined
              ? {}
              : { ConditionExpression: expected === 0 ? "attribute_not_exists(pk)" : "#version = :expected" }),
          },
        },
        sk !== SK.deletion,
      );
    } catch (error) {
      if (blobKey && (error instanceof ConditionalCheckFailedException || error instanceof DeletedOrgError)) {
        await this.#dropBlob(blobKey);
      }
      throw error;
    }
    await this.#dropBlob(previous?.blobKey, blobKey);
  }

  async #delDoc(orgId: string, sk: string): Promise<void> {
    const result = await this.client.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: orgKey(orgId), sk }, ReturnValues: "ALL_OLD" }),
    );
    await this.#dropBlob((result.Attributes as Header | undefined)?.blobKey);
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
      await this.#writeLive(orgId, {
        Put: {
          TableName: this.table,
          Item: { pk: orgKey(orgId), sk: SK.meta, gsi1pk: ORG_LISTING, gsi1sk: orgKey(orgId) },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
    this.#known.add(orgId);
  }

  async #load(orgId: string, keys: readonly AggregateName[]): Promise<Partial<OrgState>> {
    return (await this.#loadVersioned(orgId, keys)).state;
  }

  async #loadVersioned(
    orgId: string,
    keys: readonly AggregateName[],
  ): Promise<{ state: Partial<OrgState>; versions: Map<string, number> }> {
    const persistent = [...new Set(keys.flatMap((key) => BACKING[key] ?? [key as Persistent]))];
    const [, latest, ...values] = await Promise.all([
      this.#assertLive(orgId),
      keys.includes("inventory") ? this.#latestInventoryCloud(orgId) : undefined,
      ...persistent.map((key) => this.#codecs[key].load(orgId)),
    ]);
    const loaded = Object.fromEntries(
      persistent.map((key, index) => [key, (values[index] as Loaded).value]),
    ) as Record<string, unknown>;
    const versions = new Map<string, number>();
    for (const value of values) {
      for (const [sk, version] of (value as Loaded).versions) {
        versions.set(sk, version);
      }
    }
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
    return { state: loaded as Partial<OrgState>, versions };
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
    const persistent = [...new Set(keys.flatMap((key) => BACKING[key] ?? [key as Persistent]))];
    const entriesOf = (draft: Draft<K>, key: Persistent) =>
      this.#codecs[key].entries((draft as unknown as Record<string, unknown>)[key] as never);
    let written: string[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const loaded = await this.#loadVersioned(orgId, keys);
      const draft = loaded.state as Draft<K>;
      const before = new Map(
        persistent.map(
          (key) =>
            [key, new Map([...entriesOf(draft, key)].map(([sk, value]) => [sk, JSON.stringify(value)] as const))] as const,
        ),
      );
      change(draft);
      await this.#touch(orgId);
      written = [];
      try {
        for (const key of persistent) {
          const prior = before.get(key) ?? new Map<string, string>();
          const next = entriesOf(draft, key);
          for (const [sk, value] of next) {
            if (prior.get(sk) !== JSON.stringify(value)) {
              await this.#putDoc(orgId, sk, value, { expected: loaded.versions.get(sk) ?? 0 });
              written.push(sk);
            }
          }
          for (const sk of prior.keys()) {
            if (!next.has(sk)) {
              await this.#delDoc(orgId, sk);
              written.push(`-${sk}`);
            }
          }
        }
        return draft;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }
        await backoff(attempt);
      }
    }
    throw new Error(
      `documents for ${orgId} changed concurrently after ${MAX_ATTEMPTS} attempts; the last attempt had already written [${written.join(", ")}]`,
    );
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
    for (let attempt = 0; attempt < SEQ_ATTEMPTS; attempt += 1) {
      const current = await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: { pk: orgKey(orgId), sk: SK.seq },
          ConsistentRead: true,
        }),
      );
      const prior = (current.Item as Record<string, number> | undefined)?.[kind] ?? 0;
      const next = prior + 1;
      try {
        await this.#writeLive(orgId, {
          Update: {
            TableName: this.table,
            Key: { pk: orgKey(orgId), sk: SK.seq },
            UpdateExpression: "SET #kind = :next",
            ConditionExpression: prior === 0 ? "attribute_not_exists(#kind)" : "#kind = :current",
            ExpressionAttributeNames: { "#kind": kind },
            ExpressionAttributeValues: prior === 0 ? { ":next": next } : { ":next": next, ":current": prior },
          },
        });
        return next;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }
      }
    }
    throw new Error(`sequence ${kind} for ${orgId} changed concurrently after ${SEQ_ATTEMPTS} attempts`);
  }

  async #raiseSequence(orgId: string, kind: Sequence, floor: number): Promise<void> {
    try {
      await this.#writeLive(orgId, {
        Update: {
          TableName: this.table,
          Key: { pk: orgKey(orgId), sk: SK.seq },
          UpdateExpression: "SET #kind = :floor",
          ConditionExpression: "attribute_not_exists(#kind) OR #kind < :floor",
          ExpressionAttributeNames: { "#kind": kind },
          ExpressionAttributeValues: { ":floor": floor },
        },
      });
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
  }

  async putConnection(orgId: string, input: ConnectionInput, fixedId?: string): Promise<Connection> {
    assertNoSecrets(input);
    const cloud = input.cloud ?? DEFAULT_CLOUD;
    const probed = probeRoles(cloud, input.grantedRoles ?? presentRoles(cloud));
    const connection: Connection = {
      id: fixedId ?? `conn-${await this.nextSequence(orgId, "connection")}`,
      cloud,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      roles: probed.roles,
      missingRoles: probed.missingRoles,
      createdAt: this.clock(),
      healthy: probed.healthy,
    };
    markVerified(connection);
    if (fixedId === undefined) {
      await this.#putDoc(orgId, connectionSk(connection.id), connection);
      return connection;
    }
    await this.#touch(orgId);
    try {
      await this.#putDoc(orgId, connectionSk(fixedId), connection, { expected: 0 });
      await this.#raiseSequence(orgId, "connection", sequenceOf(fixedId));
      return connection;
    } catch (error) {
      const existing = await this.#getDoc<Connection>(orgId, connectionSk(fixedId));
      if (error instanceof ConditionalCheckFailedException && existing) {
        return existing.value;
      }
      throw error;
    }
  }

  async patchConnection(
    orgId: string,
    connectionId: string,
    patch: ConnectionPatch,
  ): Promise<Connection | null> {
    let patched: Connection | null = null;
    await this.#mutate(orgId, ["connections"], (draft) => {
      patched = draft.connections.find((item) => item.id === connectionId) ?? null;
      if (patched) {
        if (patch.healthy !== undefined) {
          patched.healthy = patch.healthy;
        }
        if (patch.roles !== undefined) {
          patched.roles = patch.roles;
        }
        if (patch.missingRoles !== undefined) {
          patched.missingRoles = patch.missingRoles;
        }
        assertNoSecrets(patched);
        markVerified(patched);
      }
    });
    return patched;
  }

  async deleteConnection(orgId: string, connectionId: string): Promise<boolean> {
    let found = false;
    await this.#mutate(orgId, SUBSCRIPTION_KEYS, (draft) => {
      const removed = draft.connections.find((connection) => connection.id === connectionId);
      found = removed !== undefined;
      if (!removed) {
        return;
      }
      draft.connections = draft.connections.filter((connection) => connection.id !== connectionId);
      const target = removed.subscriptionId.toLowerCase();
      if (!draft.connections.some((connection) => connection.subscriptionId.toLowerCase() === target)) {
        dropSubscription(draft, removed.subscriptionId);
      }
    });
    return found;
  }

  async purgeSubscription(orgId: string, subscriptionId: string): Promise<void> {
    const target = subscriptionId.toLowerCase();
    await this.#mutate(orgId, SUBSCRIPTION_KEYS, (draft) => {
      if (!draft.connections.some((connection) => connection.subscriptionId.toLowerCase() === target)) {
        dropSubscription(draft, subscriptionId);
      }
    });
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
    await this.#writeLive(orgId, {
      Update: {
        TableName: this.table,
        Key: { pk: orgKey(orgId), sk: SK.meta },
        UpdateExpression: "SET latestInventory = :cloud",
        ExpressionAttributeValues: { ":cloud": inventory.cloud },
      },
    });
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

  async updateSchedule(
    orgId: string,
    mutate: (schedule: ScheduleState, settings: OrgSettings) => void,
  ): Promise<ScheduleState> {
    await this.#touch(orgId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const [current, loadedSettings] = await Promise.all([
        this.#getDoc<ScheduleState>(orgId, SK.schedule),
        this.#codecs.settings.load(orgId),
      ]);
      const next = current?.value ?? emptySchedule();
      mutate(next, loadedSettings.value as OrgSettings);
      try {
        await this.#putDoc(orgId, SK.schedule, next, { expected: current?.version ?? 0 });
        return next;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }
        await backoff(attempt);
      }
    }
    throw new Error(`schedule for ${orgId} changed concurrently`);
  }

  async putJob(input: Omit<ScanJob, "id">, fixedId?: string): Promise<ScanJob> {
    assertNoSecrets(input);
    const sequence = fixedId === undefined ? await this.nextSequence(input.orgId, "scan") : sequenceOf(fixedId);
    const job: ScanJob = { ...input, id: fixedId ?? `scan-${sequence}` };
    markVerified(job);
    await this.#touch(input.orgId);
    try {
      await this.#putDoc(input.orgId, scanSk(job.id), job, { ...scanOptions(job), expected: 0 });
      if (fixedId !== undefined) {
        await this.#raiseSequence(input.orgId, "scan", sequence);
      }
    } catch (error) {
      const existing = fixedId === undefined ? undefined : await this.#getDoc<ScanJob>(input.orgId, scanSk(fixedId));
      if (error instanceof ConditionalCheckFailedException && existing) {
        return existing.value;
      }
      throw error;
    }
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
    return stored?.value;
  }

  async patchJob(orgId: string, jobId: string, patch: Partial<ScanJob>): Promise<ScanJob> {
    await this.#touch(orgId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
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
        await backoff(attempt);
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

  async mergeScan(orgId: string, cloud: Cloud, merge: (draft: ScanMergeDraft) => void): Promise<void> {
    await this.#mutate(orgId, ["inventories", "facts", "findings", "coverage", "issues", "cost", "costs"], (draft) => {
      merge(draft);
      assertNoSecrets({
        inventory: draft.inventories[cloud],
        facts: draft.facts,
        findings: draft.findings,
        coverage: draft.coverage,
        issues: draft.issues,
      });
    });
    await this.#writeLive(orgId, {
      Update: {
        TableName: this.table,
        Key: { pk: orgKey(orgId), sk: SK.meta },
        UpdateExpression: "SET latestInventory = :cloud",
        ExpressionAttributeValues: { ":cloud": cloud },
      },
    });
  }

  async seeded(orgId: string): Promise<boolean> {
    return (await this.#getDoc(orgId, SK.seeded)) !== undefined;
  }

  async markSeeded(orgId: string): Promise<void> {
    await this.#touch(orgId);
    try {
      await this.#putDoc(orgId, SK.seeded, { at: this.clock() }, { expected: 0 });
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
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
      await this.#putDoc(orgId, SK.deletion, record, {
        expected: 0,
        extra: { gsi1pk: DELETED_LISTING, gsi1sk: record.deletedAt },
      });
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return (await this.deletion(orgId)) ?? record;
      }
      throw error;
    }
    this.#deleted.set(orgId, record);
    this.#known.delete(orgId);
    await this.#purge(orgId);
    await this.#purge(orgId);
    return record;
  }

  async #purge(orgId: string): Promise<void> {
    await this.blobs.deletePrefix(`${orgKey(orgId)}/`);
    const { items } = await this.#query(orgId, { projection: "sk" });
    const keys = items.map((item) => item.sk as string).filter((sk) => sk !== SK.deletion);
    for (let start = 0; start < keys.length; start += BATCH_SIZE) {
      let pending: Record<string, unknown>[] = keys
        .slice(start, start + BATCH_SIZE)
        .map((sk) => ({ DeleteRequest: { Key: { pk: orgKey(orgId), sk } } }));
      for (let attempt = 0; pending.length > 0 && attempt < MAX_ATTEMPTS; attempt += 1) {
        const result = await this.client.send(
          new BatchWriteCommand({ RequestItems: { [this.table]: pending as never } }),
        );
        pending = (result.UnprocessedItems?.[this.table] ?? []) as Record<string, unknown>[];
        if (pending.length > 0) {
          await backoff(attempt);
        }
      }
      if (pending.length > 0) {
        throw new Error(`could not purge all items for ${orgId}`);
      }
    }
  }

  sweepRetention(now: string = this.clock(), onlyOrgId?: string): Promise<DeletionRecord[]> {
    return sweepRetention(this, now, onlyOrgId, this.log);
  }

  async repurgeDeleted(now: string = this.clock()): Promise<number> {
    const cutoff = new Date(Date.parse(now) - REPURGE_MS).toISOString();
    const { items } = await this.#query("", { index: true, indexPk: DELETED_LISTING, skFrom: cutoff });
    const orgIds = [...new Set(items.map((item) => (item.pk as string).slice(ORG_PREFIX.length)))];
    let purged = 0;
    for (const orgId of orgIds) {
      if (!(await this.deletion(orgId))) {
        continue;
      }
      await this.#purge(orgId);
      purged += 1;
    }
    return purged;
  }
}

function scanOptions(job: ScanJob): PutOptions {
  return { extra: { status: job.status, complete: job.complete } };
}
