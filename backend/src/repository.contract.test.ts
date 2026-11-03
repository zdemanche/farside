import { randomUUID } from "node:crypto";
import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DynamoDBClient,
  TransactionCanceledException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { MemoryBlobStore, type BlobStore } from "./blob-store.js";
import { sweepRetention } from "./org-ops.js";
import { seedDemoOrg } from "./demo.js";
import type { Finding, Inventory } from "@farside/scan-contracts";
import dynalite from "dynalite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Contract } from "./billing.js";
import type { CommitmentSnapshot } from "./commitments.js";
import type { CostSnapshot } from "./cost.js";
import { MIXED_CURRENCY_CLOSER } from "./cost-total.js";
import { recordCoverageScope } from "./coverage.js";
import { DynamoStore, documentClient, INLINE_BYTES, ORG_INDEX } from "./dynamo-store.js";
import type { ResourceFacts } from "./facts.js";
import type { StoredIssue } from "./issues.js";
import { DeletedOrgError } from "./offboard.js";
import { MAX_SCANS_PER_ORG, type AggregateName, type OrgRepository, type ScanMergeDraft } from "./repository.js";
import type { ScanJob } from "./scans.js";
import { SecretLeakError } from "./secrets.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { MemoryStore } from "./store.js";
import { fixedClock } from "./test-clock.js";

let TABLE = "farside-contract-test";
const blobs = new MemoryBlobStore();
const NOW = "2026-11-03T00:00:00.000Z";

let server: ReturnType<typeof dynalite> | undefined;
let rawClient: DynamoDBClient;
let docClient: DynamoDBDocumentClient;

beforeAll(async () => {
  let endpoint = process.env.DYNAMO_ENDPOINT;
  if (endpoint) {
    TABLE = `farside-contract-${randomUUID().slice(0, 8)}`;
  } else {
    server = dynalite({ createTableMs: 0 });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;
  }
  rawClient = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  docClient = process.env.DYNAMO_ENDPOINT ? documentClient(rawClient) : withTransactShim(documentClient(rawClient));
  await rawClient.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: ORG_INDEX,
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
        },
      ],
    }),
  );
  await waitUntilTableExists({ client: rawClient, maxWaitTime: 60 }, { TableName: TABLE });
});

afterAll(async () => {
  rawClient.destroy();
  const closing = server;
  if (closing) {
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

const newDynamo = () => new DynamoStore(docClient, TABLE, blobs, fixedClock);

const orgName = () => `org-${randomUUID().slice(0, 8)}`;

function inventoryOf(cloud: "azure" | "gcp", count: number, subscription = "main"): Inventory {
  return {
    cloud,
    observedAt: NOW,
    resources: Array.from({ length: count }, (_, index) => ({
      resourceUri:
        cloud === "azure"
          ? `/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.Compute/disks/disk-${index}`
          : `//compute.googleapis.com/projects/${subscription}/zones/us-central1-a/disks/disk-${index}`,
      resourceType: "Microsoft.Compute/disks",
      region: "eastus",
      displayName: `disk-${index} with a reasonably descriptive display name to add weight`,
      tags: { team: "core", environment: "production", costCenter: `cc-${index % 40}` },
      ownerTag: null,
    })),
  };
}

const finding = (subscription: string): Finding => ({
  checkId: "azure-waste-unattached-disks",
  result: "fail",
  evidence: { fields: { diskId: "disk-1", diskState: "Unattached" } },
  scope: { id: `${subscription}:azure-waste-unattached-disks`, cloud: "azure", subscriptionOrProject: subscription },
  savings: { min: "8.00", max: "12.00", currency: "USD" },
});

const issue = (subscription: string): StoredIssue => ({
  id: `issue-${subscription}`,
  checkId: "azure-waste-unattached-disks",
  resourceId: "disk-1",
  scopeId: `${subscription}:azure-waste-unattached-disks`,
  cloud: "azure",
  subscriptionOrProject: subscription,
  status: "open",
  evidence: { diskId: "disk-1" },
  coverage: "assessed",
  firstSeen: NOW,
  lastConfirmed: NOW,
});

const facts = (subscription: string): ResourceFacts => ({
  resourceUri: `/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.Compute/disks/disk-1`,
  fields: { diskId: "disk-1", location: "eastus" },
});

const cost = (subscriptionId: string, currency: string): CostSnapshot => ({
  subscriptionId,
  billingScope: `/subscriptions/${subscriptionId}`,
  currency,
  agreementType: "payg",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  asOf: NOW,
  provisionalDate: null,
  services: [],
  months: [
    {
      billingScope: `/subscriptions/${subscriptionId}`,
      currency,
      agreementType: "payg",
      serviceName: "all",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      costAmount: "10.00",
      provisional: false,
    },
  ],
  serviceMonths: [],
  monthOnMonth: [],
});

const commitments = (subscriptionId: string): CommitmentSnapshot => ({
  subscriptionId,
  billingScope: `/subscriptions/${subscriptionId}`,
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  reservations: [],
  savingsPlans: [],
  noneFound: { reservations: true, savingsPlans: true },
});

const contractEndedLongAgo: Contract = {
  plan: "standard",
  startDate: "2025-01-01T00:00:00.000Z",
  endDate: "2025-06-01T00:00:00.000Z",
  state: "ended",
  amountDue: "0.00",
  currency: "USD",
  unpaidAt: null,
  stateChangedAt: "2025-06-01T00:00:00.000Z",
};

const job = (orgId: string, overrides: Partial<Omit<ScanJob, "id">> = {}): Omit<ScanJob, "id"> => ({
  orgId,
  subscriptionId: "main",
  cloud: null,
  actor: "user",
  status: "queued",
  complete: false,
  coveredScopes: [],
  createdAt: NOW,
  startedAt: null,
  finishedAt: null,
  error: null,
  durationMs: null,
  coverageSummary: { assessed: 0, unassessed: 0, undetermined: 0 },
  checks: [],
  ...overrides,
});

function scanMerge(subscription: string) {
  return (draft: ScanMergeDraft) => {
    const inventory = inventoryOf("azure", 1, subscription);
    draft.inventories.azure = {
      ...inventory,
      resources: [
        ...(draft.inventories.azure?.resources ?? []).filter((row) => !row.resourceUri.includes(`/${subscription}/`)),
        ...inventory.resources,
      ],
    };
    draft.findings = [...draft.findings.filter((row) => row.scope.subscriptionOrProject !== subscription), finding(subscription)];
    draft.issues = [...draft.issues.filter((row) => row.subscriptionOrProject !== subscription), issue(subscription)];
  };
}

const EVERY_AGGREGATE: AggregateName[] = [
  "connections",
  "inventory",
  "inventories",
  "coverage",
  "findings",
  "settings",
  "scans",
  "facts",
  "issues",
  "cost",
  "costs",
  "commitments",
  "commitmentsBySubscription",
  "budgets",
  "alerts",
  "schedule",
  "contract",
];

const implementations: { name: string; create: () => OrgRepository }[] = [
  { name: "MemoryStore", create: () => new MemoryStore(fixedClock) },
  { name: "DynamoStore", create: newDynamo },
];

describe.each(implementations)("OrgRepository contract: $name", ({ create }) => {
  it("stores connections in order, never reuses an id and rejects secrets", async () => {
    const store = create();
    const org = orgName();
    const first = await store.putConnection(org, { tenantId: "t1", subscriptionId: "sub-a" });
    const second = await store.putConnection(org, { tenantId: "t1", subscriptionId: "sub-b", cloud: "gcp" });
    expect([first.id, second.id]).toEqual(["conn-1", "conn-2"]);
    expect(second.cloud).toBe("gcp");
    expect((await store.read(org, "connections")).connections.map((item) => item.id)).toEqual(["conn-1", "conn-2"]);
    expect(await store.isConnected(org, "SUB-A")).toBe(true);
    expect(await store.isConnected(org, "sub-z")).toBe(false);
    expect(await store.patchConnection(org, first.id, { healthy: false })).toMatchObject({ id: "conn-1", healthy: false });
    expect(await store.patchConnection(org, "conn-99", { healthy: false })).toBeNull();
    expect((await store.read(org, "connections")).connections[0]?.healthy).toBe(false);
    expect(await store.deleteConnection(org, "conn-99")).toBe(false);
    expect(await store.deleteConnection(org, first.id)).toBe(true);
    const third = await store.putConnection(org, { tenantId: "t1", subscriptionId: "sub-c" });
    expect(third.id).toBe("conn-3");
    expect((await store.read(org, "connections")).connections.map((item) => item.id)).toEqual(["conn-2", "conn-3"]);
    await expect(
      store.putConnection(org, { tenantId: "t1", subscriptionId: "x", client_secret: "hunter2hunter2" } as never),
    ).rejects.toBeInstanceOf(SecretLeakError);
  });

  it("round-trips the document aggregates and clears the nullable ones", async () => {
    const store = create();
    const org = orgName();
    const coverage = [recordCoverageScope({ subscriptionOrProject: "main", checkId: "azure-waste-unattached-disks", state: "assessed" })];
    await store.putCoverage(org, coverage);
    await store.putFindings(org, [finding("main")]);
    await store.putFacts(org, [facts("main")]);
    await store.putIssues(org, [issue("main")]);
    await store.putBudgets(org, { lastConfirmed: NOW } as never);
    await store.putAlerts(org, { alerts: [] } as never);
    await store.putContract(org, contractEndedLongAgo);
    const read = await store.read(org, "coverage", "findings", "facts", "issues", "budgets", "alerts", "contract");
    expect(read.coverage).toEqual(coverage);
    expect(read.findings).toEqual([finding("main")]);
    expect(read.facts).toEqual([facts("main")]);
    expect(read.issues).toEqual([issue("main")]);
    expect(read.budgets).toEqual({ lastConfirmed: NOW });
    expect(read.alerts).toEqual({ alerts: [] });
    expect(read.contract).toEqual(contractEndedLongAgo);
    await store.putBudgets(org, null);
    await store.putAlerts(org, null);
    await store.putContract(org, null);
    expect(await store.read(org, "budgets", "alerts", "contract")).toEqual({ budgets: null, alerts: null, contract: null });
    await expect(store.putFindings(org, [{ ...finding("main"), evidence: { fields: { client_secret: "hunter2hunter2" } } }])).rejects.toBeInstanceOf(
      SecretLeakError,
    );
  });

  it("defaults an org that was never written", async () => {
    const store = create();
    const read = await store.read(orgName(), ...EVERY_AGGREGATE);
    expect(read).toMatchObject({
      connections: [],
      inventory: null,
      inventories: {},
      coverage: [],
      findings: [],
      scans: [],
      facts: [],
      issues: [],
      cost: null,
      costs: {},
      commitments: null,
      commitmentsBySubscription: {},
      budgets: null,
      alerts: null,
      contract: null,
    });
    expect(read.settings).toMatchObject({ ownerTagKey: DEFAULT_SETTINGS.ownerTagKey });
    expect(read.schedule).toMatchObject({ nextRunAt: null, records: [] });
  });

  it("keeps per-cloud inventories, tracks the latest one and re-tags them when settings change", async () => {
    const store = create();
    const org = orgName();
    await store.putInventory(org, inventoryOf("azure", 3));
    await store.putInventory(org, inventoryOf("gcp", 2, "proj"));
    const read = await store.read(org, "inventory", "inventories");
    expect(Object.keys(read.inventories).sort()).toEqual(["azure", "gcp"]);
    expect(read.inventory?.cloud).toBe("gcp");
    await store.putSettings(org, { ...DEFAULT_SETTINGS, ownerTagKey: "team", updatedAt: NOW });
    const retagged = await store.read(org, "inventories", "inventory", "settings");
    expect(retagged.settings.ownerTagKey).toBe("team");
    expect(retagged.inventories.azure?.resources.every((resource) => resource.ownerTag === "core")).toBe(true);
    expect(retagged.inventory?.resources.every((resource) => resource.ownerTag === "core")).toBe(true);
  });

  it("keeps one cost and one commitment snapshot per subscription and marks mixed currencies", async () => {
    const store = create();
    const org = orgName();
    await store.putCoverage(org, [recordCoverageScope({ subscriptionOrProject: "sub-a", checkId: "azure-waste-unattached-disks", state: "assessed" })]);
    await store.putCost(org, cost("sub-a", "USD"));
    await store.putCost(org, cost("sub-b", "EUR"));
    await store.putCommitments(org, commitments("sub-a"));
    await store.putCommitments(org, commitments("sub-b"));
    const mixed = await store.read(org, "cost", "costs", "commitments", "commitmentsBySubscription", "coverage");
    expect(Object.keys(mixed.costs).sort()).toEqual(["sub-a", "sub-b"]);
    expect(mixed.cost).toBeNull();
    expect(Object.keys(mixed.commitmentsBySubscription).sort()).toEqual(["sub-a", "sub-b"]);
    expect(mixed.commitments?.subscriptionId).toBe("sub-a,sub-b");
    expect(mixed.coverage.some((entry) => entry.state !== "assessed")).toBe(true);
    await store.putCost(org, null, "sub-b");
    await store.putCommitments(org, null, "sub-b");
    const single = await store.read(org, "cost", "costs", "commitments", "coverage");
    expect(single.cost).not.toBeNull();
    expect(Object.keys(single.costs)).toEqual(["sub-a"]);
    expect(single.commitments?.subscriptionId).toBe("sub-a");
    expect(
      single.coverage.filter((entry) => entry.subscriptionOrProject === "sub-a" && entry.closer === MIXED_CURRENCY_CLOSER),
    ).toEqual([]);
    await store.putCost(org, null, undefined);
    expect((await store.read(org, "costs", "cost")).cost).toBeNull();
  });

  it("drops a subscription's data when its last connection is removed", async () => {
    const store = create();
    const org = orgName();
    const keep = await store.putConnection(org, { tenantId: "t", subscriptionId: "keep" });
    const drop = await store.putConnection(org, { tenantId: "t", subscriptionId: "drop" });
    await store.putInventory(org, { ...inventoryOf("azure", 2, "keep"), resources: [...inventoryOf("azure", 2, "keep").resources, ...inventoryOf("azure", 2, "drop").resources] });
    await store.putFacts(org, [facts("keep"), facts("drop")]);
    await store.putFindings(org, [finding("keep"), finding("drop")]);
    await store.putIssues(org, [issue("keep"), issue("drop")]);
    await store.putCost(org, cost("keep", "USD"));
    await store.putCost(org, cost("drop", "USD"));
    expect(await store.deleteConnection(org, drop.id)).toBe(true);
    const read = await store.read(org, "connections", "inventories", "facts", "findings", "issues", "costs");
    expect(read.connections.map((item) => item.id)).toEqual([keep.id]);
    expect(read.inventories.azure?.resources).toHaveLength(2);
    expect(read.facts.map((row) => row.resourceUri)).toEqual([facts("keep").resourceUri]);
    expect(read.findings.map((row) => row.scope.subscriptionOrProject)).toEqual(["keep"]);
    expect(read.issues.find((row) => row.subscriptionOrProject === "drop")).toMatchObject({ status: "closed", closedReason: "subscription disconnected" });
    expect(Object.keys(read.costs)).toEqual(["keep"]);
  });

  it("purges a subscription's data only while no connection still uses it", async () => {
    const store = create();
    const org = orgName();
    await store.putConnection(org, { tenantId: "t", subscriptionId: "sub-a" });
    await store.putFindings(org, [finding("sub-a"), finding("sub-b")]);
    await store.putIssues(org, [issue("sub-a"), issue("sub-b")]);
    await store.purgeSubscription(org, "SUB-A");
    expect((await store.read(org, "findings")).findings).toHaveLength(2);
    await store.purgeSubscription(org, "sub-b");
    expect((await store.read(org, "findings", "issues"))).toMatchObject({
      findings: [{ scope: { subscriptionOrProject: "sub-a" } }],
    });
    expect((await store.read(org, "issues")).issues.find((row) => row.subscriptionOrProject === "sub-b")).toMatchObject({
      status: "closed",
    });
  });

  it("keeps every change when different subscriptions' costs are written concurrently", async () => {
    const store = create();
    const org = orgName();
    const subscriptions = Array.from({ length: 6 }, (_, index) => `sub-${index}`);
    await Promise.all(subscriptions.map((id) => store.putCost(org, cost(id, "USD"))));
    expect(Object.keys((await store.read(org, "costs")).costs).sort()).toEqual(subscriptions);
  });

  it("accumulates scan merges for different subscriptions", async () => {
    const store = create();
    const org = orgName();
    await store.mergeScan(org, "azure", scanMerge("sub-a"));
    await store.mergeScan(org, "azure", scanMerge("sub-b"));
    await store.mergeScan(org, "azure", scanMerge("sub-a"));
    const read = await store.read(org, "findings", "issues", "inventory", "inventories");
    expect(read.findings.map((row) => row.scope.subscriptionOrProject).sort()).toEqual(["sub-a", "sub-b"]);
    expect(read.issues).toHaveLength(2);
    expect(read.inventory?.resources).toHaveLength(2);
    expect(read.inventories.azure?.resources).toHaveLength(2);
  });

  it("keeps fixed-id writes from colliding with later generated ids", async () => {
    const store = create();
    const org = orgName();
    await store.putConnection(org, { tenantId: "t", subscriptionId: "a" }, "conn-5");
    await store.putConnection(org, { tenantId: "t", subscriptionId: "a" }, "conn-5");
    expect((await store.putConnection(org, { tenantId: "t", subscriptionId: "b" })).id).toBe("conn-6");
    await store.putJob(job(org), "scan-3");
    expect((await store.putJob(job(org))).id).toBe("scan-4");
    expect((await store.read(org, "connections")).connections.map((item) => item.id)).toEqual(["conn-5", "conn-6"]);
  });

  it("hands out unique, monotonic sequence numbers under concurrent increments", async () => {
    const store = create();
    const org = orgName();
    const issued = await Promise.all(Array.from({ length: 25 }, () => store.nextSequence(org, "schedule")));
    expect(new Set(issued).size).toBe(25);
    expect([...issued].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(await store.nextSequence(org, "schedule")).toBe(26);
    expect(await store.nextSequence(org, "scan")).toBe(1);
  });

  it("applies concurrent schedule updates without losing any", async () => {
    const store = create();
    const org = orgName();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.updateSchedule(org, (schedule) => {
          schedule.retryCounts[`sub-${index}`] = index;
        }),
      ),
    );
    const { schedule } = await store.read(org, "schedule");
    expect(Object.keys(schedule.retryCounts).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `sub-${index}`));
    const updated = await store.updateSchedule(org, (current) => {
      current.nextRunAt = NOW;
    });
    expect(updated.nextRunAt).toBe(NOW);
    expect((await store.read(org, "schedule")).schedule.nextRunAt).toBe(NOW);
  });

  it("creates, patches and finds scans", async () => {
    const store = create();
    const org = orgName();
    const created = await Promise.all([1, 2, 3, 4, 5].map((index) => store.putJob(job(org, { subscriptionId: `sub-${index}` }))));
    expect(new Set(created.map((scan) => scan.id)).size).toBe(5);
    const ordered = (await store.read(org, "scans")).scans.map((scan) => scan.id);
    expect(ordered).toEqual([...ordered].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))));
    const first = ordered[0] as string;
    expect(await store.getJob(org, first)).toMatchObject({ id: first, status: "queued" });
    expect(await store.getJob(org, "scan-999")).toBeUndefined();
    const patched = await store.patchJob(org, first, { status: "running", id: "scan-777", orgId: "other" } as never);
    expect(patched).toMatchObject({ id: first, orgId: org, status: "running" });
    await expect(store.patchJob(org, "scan-999", { status: "failed" })).rejects.toThrow("scan scan-999 missing");
    expect(await store.runningScan(org, (await store.getJob(org, first))?.subscriptionId as string)).toMatchObject({ id: first });
    await store.patchJob(org, first, { status: "succeeded", complete: true });
    expect(await store.runningScan(org, (await store.getJob(org, first))?.subscriptionId as string)).toBeUndefined();

  });

  it("prunes the oldest settled scans past the cap but keeps in-flight and current ones", async () => {
    const store = create();
    const org = orgName();
    const running = await store.putJob(job(org, { status: "running" }));
    const current = await store.putJob(job(org, { status: "succeeded", complete: true }));
    for (let index = 0; index < MAX_SCANS_PER_ORG + 3; index += 1) {
      await store.putJob(job(org, { status: "failed" }));
    }
    const ids = (await store.read(org, "scans")).scans.map((scan) => scan.id);
    expect(ids).toHaveLength(MAX_SCANS_PER_ORG);
    expect(ids).toContain(running.id);
    expect(ids).toContain(current.id);
  }, 60_000);

  it("round-trips an inventory larger than a single DynamoDB item and shrinks it again", async () => {
    const store = create();
    const org = orgName();
    const big = inventoryOf("azure", 6_000);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(INLINE_BYTES * 2);
    await store.putInventory(org, big);
    expect((await store.read(org, "inventories")).inventories.azure).toEqual(big);
    await store.putFacts(org, Array.from({ length: 8_000 }, (_, index) => ({ ...facts("main"), resourceUri: `${facts("main").resourceUri}-${index}` })));
    expect((await store.read(org, "facts")).facts).toHaveLength(8_000);
    const small = inventoryOf("azure", 2);
    await store.putInventory(org, small);
    expect((await store.read(org, "inventories")).inventories.azure).toEqual(small);
  }, 60_000);

  it("offboards: erases every aggregate, keeps the deletion record and refuses later access", async () => {
    const store = create();
    const org = orgName();
    const bystander = orgName();
    await store.putConnection(bystander, { tenantId: "t", subscriptionId: "other" });
    await store.putConnection(org, { tenantId: "t", subscriptionId: "main" });
    await store.putInventory(org, inventoryOf("azure", 5));
    await store.putFacts(org, [facts("main")]);
    await store.putFindings(org, [finding("main")]);
    await store.putIssues(org, [issue("main")]);
    await store.putCoverage(org, [recordCoverageScope({ subscriptionOrProject: "main", checkId: "azure-waste-unattached-disks", state: "assessed" })]);
    await store.putCost(org, cost("main", "USD"));
    await store.putCommitments(org, commitments("main"));
    await store.putBudgets(org, { lastConfirmed: NOW } as never);
    await store.putAlerts(org, { alerts: [] } as never);
    await store.putContract(org, { ...contractEndedLongAgo, endDate: null, state: "active" });
    await store.putJob(job(org, { status: "queued" }));
    await store.updateSchedule(org, (schedule) => {
      schedule.nextRunAt = NOW;
    });
    expect(await store.hasOrg(org)).toBe(true);
    expect(await store.orgIds()).toEqual(expect.arrayContaining([org, bystander]));

    const record = await store.offboard(org, NOW, "customer", "actor-1");
    expect(record).toMatchObject({
      orgId: org,
      requestedBy: "actor-1",
      deletedAt: NOW,
      trigger: "customer",
      connectionsRemoved: 1,
      scansStopped: 1,
      rowsPurged: { connections: 1, inventoryResources: 5, facts: 1, findings: 1, issues: 1, coverage: 1, scans: 1, costSnapshots: 1, commitments: 1, budgets: 1, alerts: 1, contract: 1 },
    });
    expect(await store.deletion(org)).toEqual(record);
    expect(await store.offboard(org, "2027-01-01T00:00:00.000Z")).toEqual(record);
    expect(await store.hasOrg(org)).toBe(false);
    expect(await store.orgIds()).not.toContain(org);
    expect(await store.orgIds()).toContain(bystander);
    await expect(store.read(org, ...EVERY_AGGREGATE)).rejects.toBeInstanceOf(DeletedOrgError);
    await expect(store.putFindings(org, [])).rejects.toBeInstanceOf(DeletedOrgError);
    await expect(store.putConnection(org, { tenantId: "t", subscriptionId: "again" })).rejects.toBeInstanceOf(DeletedOrgError);
    expect((await store.read(bystander, "connections")).connections).toHaveLength(1);
  });

  it("offboards an org that never stored anything", async () => {
    const store = create();
    const org = orgName();
    expect(await store.offboard(org, NOW)).toMatchObject({ orgId: org, connectionsRemoved: 0, rowsPurged: { settings: 0 } });
  });

  it("aborts in-flight scans on offboard", async () => {
    const store = create();
    const org = orgName();
    await store.putConnection(org, { tenantId: "t", subscriptionId: "main" });
    const { signal, release } = store.trackScan(org);
    expect(signal.aborted).toBe(false);
    const record = await store.offboard(org, NOW);
    expect(signal.aborted).toBe(true);
    expect(record.scansStopped).toBe(1);
    release();
  });

  it("lists the orgs that hold data", async () => {
    const store = create();
    const [a, b] = [orgName(), orgName()];
    await store.putConnection(a, { tenantId: "t", subscriptionId: "main" });
    await store.putFindings(b, []);
    expect(await store.orgIds()).toEqual(expect.arrayContaining([a, b]));
  });

  it("sweeps retention for orgs whose contract retention elapsed", async () => {
    const store = create();
    const due = orgName();
    const live = orgName();
    await store.putContract(due, contractEndedLongAgo);
    await store.putContract(live, { ...contractEndedLongAgo, endDate: null, state: "active" });
    const records = await store.sweepRetention(NOW);
    expect(records.map((record) => record.orgId)).toContain(due);
    expect(records.map((record) => record.orgId)).not.toContain(live);
    expect(await store.deletion(due)).toMatchObject({ trigger: "retention", requestedBy: "system" });
    expect(await store.deletion(live)).toBeNull();
    expect(await store.sweepRetention(NOW, live)).toEqual([]);
  });
});

describe("DynamoStore persistence", () => {
  it("serves the same state to a new instance on the same table", async () => {
    const before = newDynamo();
    const org = orgName();
    await before.putConnection(org, { tenantId: "t", subscriptionId: "main" });
    await before.putInventory(org, inventoryOf("azure", 4));
    await before.putJob(job(org));
    await before.updateSchedule(org, (schedule) => {
      schedule.nextRunAt = NOW;
    });
    await before.nextSequence(org, "schedule");

    const after = newDynamo();
    const read = await after.read(org, "connections", "inventory", "scans", "schedule");
    expect(read.connections.map((item) => item.id)).toEqual(["conn-1"]);
    expect(read.inventory?.resources).toHaveLength(4);
    expect(read.scans.map((scan) => scan.id)).toEqual(["scan-1"]);
    expect(read.schedule.nextRunAt).toBe(NOW);
    expect(await after.nextSequence(org, "schedule")).toBe(2);
    expect((await after.putJob(job(org))).id).toBe("scan-2");
    expect(await after.orgIds()).toContain(org);
  });

  it("two instances share one deletion state", async () => {
    const [first, second] = [newDynamo(), newDynamo()];
    const org = orgName();
    await first.putConnection(org, { tenantId: "t", subscriptionId: "main" });
    await first.offboard(org, NOW);
    expect(await second.deletion(org)).toMatchObject({ orgId: org });
    await expect(second.putFindings(org, [])).rejects.toBeInstanceOf(DeletedOrgError);
  });

  it("leaves only the deletion record behind after an offboard, including large documents", async () => {
    const store = newDynamo();
    const org = orgName();
    await store.putInventory(org, inventoryOf("azure", 6_000));
    await store.putConnection(org, { tenantId: "t", subscriptionId: "main" });
    await store.offboard(org, NOW);
    const items = await rawItems(org);
    expect(items.map((item) => item.sk)).toEqual(["DELETION"]);
    expect(blobs.keys(`ORG#${org}/`)).toEqual([]);
  });

  it("rejects a write that lands after the deletion marker and leaves no item behind", async () => {
    const org = orgName();
    let fired = false;
    const racing = new DynamoStore(
      interceptingClient(async (command) => {
        if (!fired && writesSk(command, "FINDINGS")) {
          fired = true;
          await docClient.send(
            new PutCommand({
              TableName: TABLE,
              Item: { pk: `ORG#${org}`, sk: "DELETION", version: 1, body: JSON.stringify({ orgId: org, deletedAt: NOW }) },
            }),
          );
        }
      }),
      TABLE,
      blobs,
      fixedClock,
    );
    await expect(racing.putFindings(org, [finding("main")])).rejects.toBeInstanceOf(DeletedOrgError);
    expect((await rawItems(org)).map((item) => item.sk)).not.toContain("FINDINGS");
    await expect(racing.nextSequence(org, "scan")).rejects.toBeInstanceOf(DeletedOrgError);
    await newDynamo().offboard(org, NOW);
    expect((await rawItems(org)).map((item) => item.sk)).toEqual(["DELETION"]);
  });

  it("re-purges leftovers for orgs deleted in the last 48 hours and leaves live orgs and older deletions alone", async () => {
    const store = newDynamo();
    const recent = orgName();
    const live = orgName();
    const old = orgName();
    await store.putConnection(recent, { tenantId: "t", subscriptionId: "main" });
    await store.putFindings(recent, [finding("main")]);
    await store.putConnection(live, { tenantId: "t", subscriptionId: "keep" });
    await store.putConnection(old, { tenantId: "t", subscriptionId: "main" });
    await store.offboard(recent, NOW);
    await store.offboard(old, "2026-10-31T00:00:00.000Z");
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: `ORG#${recent}`,
          sk: "FINDINGS",
          version: 1,
          body: JSON.stringify([finding("main")]),
        },
      }),
    );
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: `ORG#${recent}`, sk: "META", gsi1pk: "ORGS", gsi1sk: `ORG#${recent}` },
      }),
    );
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: `ORG#${old}`,
          sk: "FINDINGS",
          version: 1,
          body: JSON.stringify([finding("main")]),
        },
      }),
    );
    expect(await store.orgIds()).toContain(recent);
    expect(await store.orgIds()).toContain(live);
    expect(await store.repurgeDeleted(NOW)).toBeGreaterThanOrEqual(1);
    expect((await rawItems(recent)).map((item) => item.sk)).toEqual(["DELETION"]);
    expect((await rawItems(old)).map((item) => item.sk).sort()).toEqual(["DELETION", "FINDINGS"]);
    expect((await store.read(live, "connections")).connections).toHaveLength(1);
    expect(await store.orgIds()).not.toContain(recent);
    expect(await store.orgIds()).toContain(live);
  });

  it("retries a multi-document change whose base document moved underneath it", async () => {
    const org = orgName();
    const other = newDynamo();
    let writes = 0;
    let fired = false;
    const store = new DynamoStore(
      interceptingClient(async (command) => {
        if (writesSk(command, "SETTINGS")) {
          writes += 1;
          if (!fired) {
            fired = true;
            await other.putSettings(org, { ...DEFAULT_SETTINGS, ownerTagKey: "interloper", updatedAt: NOW });
          }
        }
      }),
      TABLE,
      blobs,
      fixedClock,
    );
    await store.putSettings(org, { ...DEFAULT_SETTINGS, ownerTagKey: "mine", updatedAt: NOW });
    expect(writes).toBe(2);
    expect((await other.read(org, "settings")).settings.ownerTagKey).toBe("mine");
  });

  it("keeps big documents in the blob store, replaces them on rewrite and removes them when they shrink", async () => {
    const store = newDynamo();
    const org = orgName();
    await store.putInventory(org, inventoryOf("azure", 6_000));
    const stored = () => blobs.keys(`ORG#${org}/`);
    expect(stored()).toHaveLength(1);
    const header = (await rawItems(org)).find((item) => item.sk === "INV#azure");
    expect(header).toMatchObject({ entityType: "INV", blobKey: stored()[0] });
    expect(header?.body).toBeUndefined();
    await store.putInventory(org, inventoryOf("azure", 6_000, "other-subscription"));
    expect(stored()).toHaveLength(1);
    await store.putInventory(org, inventoryOf("azure", 1));
    expect(stored()).toHaveLength(0);
    expect((await rawItems(org)).find((item) => item.sk === "INV#azure")?.blobKey).toBeUndefined();
  });

  it("still serves the new body when deleting the superseded blob fails", async () => {
    const flaky: BlobStore = {
      put: (key, body) => blobs.put(key, body),
      get: (key) => blobs.get(key),
      delete: async () => {
        throw new Error("s3 unavailable");
      },
      deletePrefix: (prefix) => blobs.deletePrefix(prefix),
    };
    const store = new DynamoStore(docClient, TABLE, flaky, fixedClock);
    const org = orgName();
    await store.putInventory(org, inventoryOf("azure", 6_000));
    await store.putInventory(org, inventoryOf("azure", 6_000, "other-subscription"));
    const read = await newDynamo().read(org, "inventories");
    expect(read.inventories.azure?.resources[0]?.resourceUri).toContain("/other-subscription/");
    await newDynamo().offboard(org, NOW);
    expect(blobs.keys(`ORG#${org}/`)).toEqual([]);
  });

  it("keeps sweeping when reading one org fails with an unexpected error", async () => {
    const errors: unknown[] = [];
    const repository = {
      orgIds: async () => ["bad", "good"],
      hasOrg: async () => true,
      read: async (orgId: string) => {
        if (orgId === "bad") {
          throw new Error("throttled");
        }
        return { contract: contractEndedLongAgo };
      },
      offboard: async (orgId: string) => ({ orgId }),
    } as unknown as OrgRepository;
    const records = await sweepRetention(repository, NOW, undefined, { info: () => undefined, error: (fields: unknown) => errors.push(fields) });
    expect(records).toEqual([{ orgId: "good" }]);
    expect(errors).toHaveLength(1);
  });

  it("re-reads the header once when the blob it pointed at was replaced", async () => {
    const org = orgName();
    const writer = newDynamo();
    await writer.putInventory(org, inventoryOf("azure", 6_000));
    const first = blobs.keys(`ORG#${org}/`)[0] as string;
    let replaced = false;
    const reader = new DynamoStore(
      interceptingClient(async () => {
        if (!replaced) {
          replaced = true;
          await writer.putInventory(org, inventoryOf("azure", 6_000, "other-subscription"));
        }
      }),
      TABLE,
      blobs,
      fixedClock,
    );
    const read = await reader.read(org, "inventories");
    expect(blobs.keys(`ORG#${org}/`)).not.toContain(first);
    expect(read.inventories.azure?.resources).toHaveLength(6_000);
  });

  it("merges interleaved scans of different subscriptions from fresh state", async () => {
    const org = orgName();
    const other = newDynamo();
    let attempts = 0;
    let fired = false;
    const racing = new DynamoStore(
      interceptingClient(async (command) => {
        if (!fired && writesSk(command, "FINDINGS")) {
          fired = true;
          await other.mergeScan(org, "azure", scanMerge("sub-b"));
        }
      }),
      TABLE,
      blobs,
      fixedClock,
    );
    await racing.mergeScan(org, "azure", (draft) => {
      attempts += 1;
      scanMerge("sub-a")(draft);
    });
    expect(attempts).toBe(2);
    const read = await racing.read(org, "findings", "issues", "inventory");
    expect(read.findings.map((row) => row.scope.subscriptionOrProject).sort()).toEqual(["sub-a", "sub-b"]);
    expect(read.issues.map((row) => row.subscriptionOrProject).sort()).toEqual(["sub-a", "sub-b"]);
    expect(read.inventory?.resources).toHaveLength(2);
  });

  it("keeps sweeping when the org index still lists an org that was deleted", async () => {
    const store = newDynamo();
    const due = orgName();
    const gone = orgName();
    await store.putContract(due, contractEndedLongAgo);
    await store.putConnection(gone, { tenantId: "t", subscriptionId: "main" });
    await store.offboard(gone, NOW);
    await docClient.send(
      new PutCommand({ TableName: TABLE, Item: { pk: `ORG#${gone}`, sk: "META", gsi1pk: "ORGS", gsi1sk: `ORG#${gone}` } }),
    );
    expect(await store.orgIds()).toContain(gone);
    const records = await store.sweepRetention(NOW);
    expect(records.map((record) => record.orgId)).toContain(due);
    expect(records.map((record) => record.orgId)).not.toContain(gone);
  });

  it("seeds the demo org once even when two containers seed at the same time, and resumes a half seed", async () => {
    const [first, second] = [newDynamo(), newDynamo()];
    await Promise.all([seedDemoOrg(first), seedDemoOrg(second)]);
    const seeded = await first.read("demo", "connections", "scans");
    expect(seeded.connections.map((item) => item.id)).toEqual(["conn-1"]);
    expect(seeded.scans.map((item) => item.id)).toEqual(["scan-1"]);
    expect(await first.seeded("demo")).toBe(true);
    await first.offboard("demo", NOW);

    const memory = new MemoryStore(fixedClock);
    const failing = vi.spyOn(memory, "putAlerts").mockImplementationOnce(async () => {
      throw new Error("died mid-seed");
    });
    await expect(seedDemoOrg(memory)).rejects.toThrow("died mid-seed");
    expect(await memory.seeded("demo")).toBe(false);
    failing.mockRestore();
    await seedDemoOrg(memory);
    expect(await memory.seeded("demo")).toBe(true);
    expect((await memory.read("demo", "connections", "scans")).connections).toHaveLength(1);
  });

  it("behaves like MemoryStore for the same sequence of writes", async () => {
    const stores = [new MemoryStore(fixedClock), newDynamo()] as const;
    const org = orgName();
    const outcomes: unknown[] = [];
    for (const store of stores) {
      const keep = await store.putConnection(org, { tenantId: "t", subscriptionId: "keep" });
      const drop = await store.putConnection(org, { tenantId: "t", subscriptionId: "drop" });
      await store.putInventory(org, { ...inventoryOf("azure", 2, "keep"), resources: [...inventoryOf("azure", 2, "keep").resources, ...inventoryOf("azure", 3, "drop").resources] });
      await store.putFacts(org, [facts("keep"), facts("drop")]);
      await store.putFindings(org, [finding("keep"), finding("drop")]);
      await store.putIssues(org, [issue("keep"), issue("drop")]);
      await store.putCoverage(org, [
        recordCoverageScope({ subscriptionOrProject: "keep", checkId: "azure-waste-unattached-disks", state: "assessed" }),
        recordCoverageScope({ subscriptionOrProject: "drop", checkId: "azure-waste-unattached-disks", state: "assessed" }),
      ]);
      await store.putCost(org, cost("keep", "USD"));
      await store.putCost(org, cost("drop", "EUR"));
      await store.putCommitments(org, commitments("keep"));
      await store.putCommitments(org, commitments("drop"));
      await store.putSettings(org, { ...DEFAULT_SETTINGS, ownerTagKey: "team", updatedAt: NOW });
      await store.deleteConnection(org, drop.id);
      await store.patchConnection(org, keep.id, { healthy: false });
      outcomes.push(JSON.parse(JSON.stringify(await store.read(org, ...EVERY_AGGREGATE.filter((key) => key !== "schedule")))));
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});

function writesSk(command: unknown, sk: string): boolean {
  if (command instanceof UpdateCommand) {
    return command.input.Key?.sk === sk;
  }
  if (command instanceof TransactWriteCommand) {
    return (command.input.TransactItems ?? []).some(
      (item) => item.Update?.Key?.sk === sk || item.Put?.Item?.sk === sk,
    );
  }
  return false;
}

function withTransactShim(client: DynamoDBDocumentClient): DynamoDBDocumentClient {
  let tail = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>) => {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    send: async (command: unknown) => {
      if (!(command instanceof TransactWriteCommand)) {
        return client.send(command as never);
      }
      return exclusive(() => emulateTransact(client, command));
    },
  } as unknown as DynamoDBDocumentClient;
}

async function emulateTransact(client: DynamoDBDocumentClient, command: TransactWriteCommand) {
  const items = command.input.TransactItems ?? [];
  const reasons = items.map(() => ({ Code: "None" }));
  const fail = (index: number): never => {
    reasons[index] = { Code: "ConditionalCheckFailed" };
    throw new TransactionCanceledException({
      message: "Transaction cancelled",
      CancellationReasons: reasons,
      $metadata: { httpStatusCode: 400 },
    });
  };
  for (const [index, item] of items.entries()) {
    const check = item.ConditionCheck;
    if (!check) {
      continue;
    }
    const got = await client.send(
      new GetCommand({ TableName: check.TableName, Key: check.Key, ConsistentRead: true }),
    );
    if (check.ConditionExpression === "attribute_not_exists(pk)" && got.Item) {
      fail(index);
    }
  }
  for (const [index, item] of items.entries()) {
    try {
      if (item.Put) {
        await client.send(
          new PutCommand({
            TableName: item.Put.TableName,
            Item: item.Put.Item,
            ConditionExpression: item.Put.ConditionExpression,
            ExpressionAttributeNames: item.Put.ExpressionAttributeNames,
            ExpressionAttributeValues: item.Put.ExpressionAttributeValues,
          }),
        );
      } else if (item.Update) {
        await client.send(new UpdateCommand(item.Update));
      }
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        fail(index);
      }
      throw error;
    }
  }
}

function interceptingClient(before: (command: unknown) => Promise<void>): DynamoDBDocumentClient {
  return {
    send: async (command: unknown) => {
      await before(command);
      return docClient.send(command as never);
    },
  } as unknown as DynamoDBDocumentClient;
}

async function rawItems(orgId: string): Promise<{ sk: string; parts?: number }[]> {
  const items: { sk: string; parts?: number }[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `ORG#${orgId}` },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    items.push(...((result.Items ?? []) as { sk: string; parts?: number }[]));
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return items;
}
