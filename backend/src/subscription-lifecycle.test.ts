import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { RESERVATION_USE, type CommitmentClient } from "./commitments.js";
import { fixtureCostClient } from "./cost.js";
import { ScanRunner, type Harvester } from "./scans.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore, SUBSCRIPTION_DISCONNECTED } from "./store.js";
import { fixedClock, FIXED_NOW, TEST_APP_OPTIONS } from "./test-clock.js";

const ORG = "org-a";
const HEADERS = { [ORG_HEADER]: ORG, [ACTOR_HEADER]: "actor-a" };
const DISK_TYPE = "Microsoft.Compute/disks";

const harvester: Harvester = {
  async harvest({ subscriptionId }) {
    const resourceUri = `/subscriptions/${subscriptionId}/resourceGroups/rg/providers/${DISK_TYPE}/disk-1`;
    return {
      inventory: {
        cloud: "azure",
        observedAt: FIXED_NOW,
        resources: [
          { resourceUri, resourceType: DISK_TYPE, region: "eastus", displayName: "disk-1", tags: {} },
        ],
      },
      coverage: [],
      coveredScopes: [],
      facts: [{ resourceUri, fields: { diskState: "Unattached", sizeGb: 32 } }],
    };
  },
};

const lowUseCommitments: CommitmentClient = {
  async list({ billingScope }) {
    const owner = billingScope.split("/")[2] ?? "";
    return {
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      reservations: [
        {
          reservationId: `res-${owner}`,
          skuName: "D2s",
          usedHours: 10,
          reservedHours: 100,
          utilisationPercent: 10,
          expiryDate: "2027-10-01",
        },
      ],
      savingsPlans: [],
    };
  },
};

async function settled(store: MemoryStore): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const busy = store.snapshot(ORG).scans.some((job) => job.status === "queued" || job.status === "running");
    if (!busy) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("scans did not settle");
}

describe("canonical subscription ids", () => {
  it("keeps one cost entry when a route harvest uses another casing than the scan", async () => {
    const store = new MemoryStore(fixedClock);
    store.putConnection(ORG, { tenantId: "t", subscriptionId: "main" });
    const costClient = fixtureCostClient();
    const app = buildApp(store, { ...TEST_APP_OPTIONS, harvester, costClient });
    const harvested = await app.inject({
      method: "POST",
      url: `/v1/orgs/${ORG}/cost`,
      headers: HEADERS,
      payload: { subscriptionId: "MAIN" },
    });
    expect(harvested.statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/v1/orgs/${ORG}/scans`, headers: HEADERS, payload: { subscriptionId: "Main" } });
    await settled(store);
    expect(store.costsOf(ORG).map((row) => row.subscriptionId)).toEqual(["main"]);
    await app.close();
  });

  it("rejects a scan for a subscription the org has not connected", async () => {
    const store = new MemoryStore(fixedClock);
    const app = buildApp(store, { ...TEST_APP_OPTIONS, harvester });
    const response = await app.inject({
      method: "POST",
      url: `/v1/orgs/${ORG}/scans`,
      headers: HEADERS,
      payload: { subscriptionId: "other" },
    });
    expect(response.statusCode).toBe(400);
    expect(store.snapshot(ORG).scans).toHaveLength(0);
    await app.close();
  });

  it("rejects a connection whose subscription id is not a plain identifier", async () => {
    const app = buildApp(new MemoryStore(fixedClock), { ...TEST_APP_OPTIONS, harvester });
    const response = await app.inject({
      method: "PUT",
      url: `/v1/orgs/${ORG}/connections`,
      headers: HEADERS,
      payload: { tenantId: "t", subscriptionId: "../providers/Microsoft.Billing" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("commitments per subscription", () => {
  it("keeps the first subscription's reservation findings and issues after scanning the second", async () => {
    const store = new MemoryStore(fixedClock);
    const runner = new ScanRunner(store, harvester, { commitmentClient: lowUseCommitments }, fixedClock);
    await runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" }).done;
    await runner.start({ orgId: ORG, subscriptionId: "sub-b", actor: "user" }).done;
    const org = store.snapshot(ORG);
    const owners = org.findings
      .filter((finding) => finding.checkId === RESERVATION_USE && finding.result === "fail")
      .map((finding) => finding.scope.subscriptionOrProject)
      .sort();
    expect(owners).toEqual(["sub-a", "sub-b"]);
    expect(
      org.issues.filter((issue) => issue.checkId === RESERVATION_USE && issue.status === "open"),
    ).toHaveLength(2);
    expect(org.commitments?.reservations.map((row) => row.reservationId).sort()).toEqual(["res-sub-a", "res-sub-b"]);
    expect(store.snapshot(ORG).commitmentsBySubscription["sub-a"]?.reservations).toHaveLength(1);
  });
});

describe("disconnecting a subscription", () => {
  it("drops its findings and coverage and closes its issues with a reason", async () => {
    const store = new MemoryStore(fixedClock);
    const connection = store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-a" });
    store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-b" });
    const runner = new ScanRunner(store, harvester, {}, fixedClock);
    await runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" }).done;
    await runner.start({ orgId: ORG, subscriptionId: "sub-b", actor: "user" }).done;
    expect(store.deleteConnection(ORG, connection.id)).toBe(true);
    const org = store.snapshot(ORG);
    expect(org.findings.some((finding) => finding.scope.subscriptionOrProject === "sub-a")).toBe(false);
    expect(org.coverage.some((entry) => entry.subscriptionOrProject === "sub-a")).toBe(false);
    const gone = org.issues.filter((issue) => issue.subscriptionOrProject === "sub-a");
    expect(gone.length).toBeGreaterThan(0);
    expect(
      gone.every(
        (issue) =>
          issue.status === "closed" &&
          issue.closedReason === SUBSCRIPTION_DISCONNECTED &&
          issue.closingScanId === undefined,
      ),
    ).toBe(true);
    expect(
      org.issues.filter((issue) => issue.subscriptionOrProject === "sub-b").every((issue) => issue.status === "open"),
    ).toBe(true);
  });

  it("keeps the data while another connection shares the subscription id in another casing", async () => {
    const store = new MemoryStore(fixedClock);
    const first = store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-a" });
    store.putConnection(ORG, { tenantId: "t2", subscriptionId: "SUB-A" });
    const runner = new ScanRunner(store, harvester, {}, fixedClock);
    await runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" }).done;
    store.deleteConnection(ORG, first.id);
    expect(store.snapshot(ORG).inventories.azure?.resources).toHaveLength(1);
  });
});

describe("offboarding with queued scans", () => {
  it("counts queued scans as stopped and drains a hung head so the queue never blocks", async () => {
    const store = new MemoryStore(fixedClock);
    const hung: Harvester = { harvest: () => new Promise(() => undefined) };
    const lines: unknown[] = [];
    const log = {
      info: (fields: unknown) => lines.push(fields),
      error: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
    };
    const runner = new ScanRunner(store, hung, {}, fixedClock, log as never);
    const first = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "system" });
    const second = runner.start({ orgId: ORG, subscriptionId: "sub-b", actor: "system" });
    const record = store.offboard(ORG, FIXED_NOW);
    expect(record.scansStopped).toBe(2);
    expect((await first.done).status).toBe("cancelled");
    expect((await second.done).status).toBe("cancelled");
    expect(lines).toContainEqual({ event: "scan.cancelled", orgId: ORG, scanId: second.job.id });
  });
});
