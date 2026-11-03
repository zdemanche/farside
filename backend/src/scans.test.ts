import { afterAll, describe, expect, it } from "vitest";
import type { Inventory } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import { NO_BUDGETS } from "./budgets.js";
import { RESERVATION_USE } from "./commitments.js";
import { SPEND_BY_SERVICE } from "./cost.js";
import { AZURE_LAUNCH_CHECK_IDS, recordCoverageScope } from "./coverage.js";
import { factsFromManifest } from "./facts.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import {
  ScanFailedError,
  ScanRunner,
  fixtureHarvester,
  type HarvestResult,
  type ScanView,
} from "./scans.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock, TEST_APP_OPTIONS, tickingClock } from "./test-clock.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const inventory: Inventory = inventoryFromManifest(MANIFEST);
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("scan job runner", () => {
  it("succeeds in the background and stores inventory and coverage", async () => {
    const store = new MemoryStore(fixedClock);
    const runner = new ScanRunner(store, fixtureHarvester(inventory));
    const { job, started, done } = runner.start({
      orgId: "org-a",
      subscriptionId: "main",
      actor: "system",
    });
    expect(started).toBe(true);
    expect(job.complete).toBe(false);
    expect(job.actor).toBe("system");
    const finished = await done;
    expect(finished.status).toBe("succeeded");
    expect(finished.complete).toBe(true);
    expect(store.snapshot("org-a").inventory?.resources.length).toBe(inventory.resources.length);
    expect(store.snapshot("org-a").coverage.length).toBeGreaterThan(0);
  });

  it("keeps harvest-driven findings and coverage when harvest clients are not wired", async () => {
    const store = new MemoryStore(fixedClock);
    store.putFindings("org-a", [
      {
        checkId: NO_BUDGETS,
        result: "fail",
        evidence: {
          fields: {
            subscriptionId: "empty-no-budget",
            budgetCount: 0,
            budgetNames: "",
            lastConfirmed: "1970-01-01T00:00:00.000Z",
          },
        },
        scope: {
          id: "empty-no-budget:azure-cost-subscriptions-without-budgets",
          cloud: "azure",
          subscriptionOrProject: "empty-no-budget",
        },
      },
      {
        checkId: RESERVATION_USE,
        result: "fail",
        evidence: { fields: { reservationId: "res-1", utilisationPercent: 10 } },
        scope: {
          id: "main:azure-cost-reservation-use",
          cloud: "azure",
          subscriptionOrProject: "main",
        },
      },
    ]);
    store.putCoverage("org-a", [
      recordCoverageScope({
        subscriptionOrProject: "main",
        checkId: SPEND_BY_SERVICE,
        state: "assessed",
      }),
      recordCoverageScope({
        subscriptionOrProject: "main",
        checkId: RESERVATION_USE,
        state: "assessed",
      }),
      recordCoverageScope({
        subscriptionOrProject: "empty-no-budget",
        checkId: NO_BUDGETS,
        state: "assessed",
      }),
    ]);
    const runner = new ScanRunner(store, fixtureHarvester(inventory));
    const { done } = runner.start({ orgId: "org-a", subscriptionId: "main", actor: "system" });
    await done;
    const org = store.snapshot("org-a");
    expect(org.findings.filter((finding) => finding.checkId === NO_BUDGETS)).toHaveLength(1);
    expect(org.findings.filter((finding) => finding.checkId === RESERVATION_USE)).toHaveLength(1);
    expect(
      org.coverage.find((entry) => entry.id === "main:azure-cost-spend-by-service")?.state,
    ).toBe("assessed");
  });

  it("stores a mid-failure without marking the scan complete", async () => {
    const store = new MemoryStore(fixedClock);
    const runner = new ScanRunner(store, {
      async harvest() {
        throw new ScanFailedError("Resource Graph call failed", [
          "main:azure-inventory-all-resources",
        ]);
      },
    });
    const { done } = runner.start({ orgId: "org-a", subscriptionId: "main", actor: "system" });
    const finished = await done;
    expect(finished.status).toBe("failed");
    expect(finished.complete).toBe(false);
    expect(finished.error).toBe("Resource Graph call failed");
    expect(finished.coveredScopes).toEqual(["main:azure-inventory-all-resources"]);
    expect(store.snapshot("org-a").inventory).toBeNull();
  });

  it("cancels quietly when the org is offboarded during a pending harvest", async () => {
    const store = new MemoryStore(fixedClock);
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    let release!: (result: HarvestResult) => void;
    const gate = new Promise<HarvestResult>((resolve) => {
      release = resolve;
    });
    const runner = new ScanRunner(store, { harvest: () => gate });
    const { done } = runner.start({ orgId: "org-a", subscriptionId: "main", actor: "user" });
    const stopped = store.offboard("org-a", "2026-01-01T00:00:00.000Z");
    release({ inventory, coverage: [], coveredScopes: [], facts: [] });
    const finished = await done;
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", record);
    expect(stopped.scansStopped).toBe(1);
    expect(finished.status).toBe("cancelled");
    expect(unhandled).toEqual([]);
    expect(store.hasOrg("org-a")).toBe(false);
  });

  it("runs only one scan at a time per subscription", async () => {
    const store = new MemoryStore(fixedClock);
    let release!: (result: HarvestResult) => void;
    const gate = new Promise<HarvestResult>((resolve) => {
      release = resolve;
    });
    const runner = new ScanRunner(store, { harvest: () => gate });
    const first = runner.start({ orgId: "org-a", subscriptionId: "main", actor: "user" });
    const second = runner.start({ orgId: "org-a", subscriptionId: "main", actor: "user" });
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    release({
      inventory,
      coverage: [],
      coveredScopes: ["main:azure-inventory-all-resources"],
      facts: [],
    });
    const finished = await first.done;
    expect(finished.status).toBe("succeeded");
    expect(store.snapshot("org-a").scans).toHaveLength(1);
  });
});

describe("scan on connect", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, { ...TEST_APP_OPTIONS, harvester: fixtureHarvester(inventory) });

  afterAll(async () => {
    await app.close();
  });

  it("starts a first scan when a connection is created", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().scanStarted).toBe(true);
    expect(["queued", "running", "succeeded"]).toContain(created.json().scan.status);
    let scan: { subscriptionId: string; status: string; complete: boolean } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await app.inject({
        method: "GET",
        url: "/v1/orgs/org-a/scans",
        headers: ORG,
      });
      scan = listed.json().scans[0] as typeof scan;
      if (scan?.status === "succeeded") {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(scan?.subscriptionId).toBe("main");
    expect(scan?.status).toBe("succeeded");
    expect(scan?.complete).toBe(true);
    const estate = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/estate",
      headers: ORG,
    });
    expect(estate.json().empty).toBe(false);
    expect(estate.json().resourceTotal).toBe(inventory.resources.length);
  });
});

describe("scan history API", () => {
  it("returns coverage, per-check outcomes and marks only the latest complete success current", async () => {
    const store = new MemoryStore(fixedClock);
    const app = buildApp(store, {
      ...TEST_APP_OPTIONS,
      clock: tickingClock(),
      harvester: fixtureHarvester(inventory),
    });
    const first = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().scan.current).toBe(false);
    const succeeded = await waitForScan(app, "scan-1", "succeeded");
    expect(succeeded.current).toBe(true);
    expect(succeeded.durationMs).toBe(Date.parse(succeeded.finishedAt ?? "") - Date.parse(succeeded.startedAt ?? ""));
    expect(succeeded.durationMs).toBeGreaterThan(0);
    expect(succeeded.coverageSummary.assessed).toBeGreaterThan(0);
    expect(succeeded.checks.map((check) => check.checkId).sort()).toEqual(
      [...AZURE_LAUNCH_CHECK_IDS].sort(),
    );
    expect(succeeded.checks.every((check) => check.state === "assessed" || check.state === "undetermined")).toBe(
      true,
    );
    const detail = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/scans/scan-1",
      headers: ORG,
    });
    expect(detail.json().current).toBe(true);
    expect(detail.json().checks.length).toBe(succeeded.checks.length);
    await app.close();
  });

  it("keeps a failed scan off current and shows the failure reason", async () => {
    const store = new MemoryStore(fixedClock);
    const app = buildApp(store, {
      ...TEST_APP_OPTIONS,
      harvester: {
        async harvest() {
          throw new ScanFailedError("Resource Graph call failed", [
            "main:azure-inventory-all-resources",
          ]);
        },
      },
    });
    const started = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(started.statusCode).toBe(202);
    const failed = await waitForScan(app, "scan-1", "failed");
    expect(failed.current).toBe(false);
    expect(failed.complete).toBe(false);
    expect(failed.error).toBe("Resource Graph call failed");
    expect(failed.checks.find((check) => check.checkId === "azure-inventory-all-resources")?.state).toBe(
      "assessed",
    );
    expect(
      failed.checks.find((check) => check.checkId === "azure-waste-unattached-disks"),
    ).toMatchObject({
      state: "unassessed",
      reason: "Scan failed before this check ran.",
    });
    await app.close();
  });

  it("updates a running scan without treating it as current", async () => {
    const store = new MemoryStore(fixedClock);
    let release!: (result: HarvestResult) => void;
    const gate = new Promise<HarvestResult>((resolve) => {
      release = resolve;
    });
    const app = buildApp(store, { ...TEST_APP_OPTIONS, harvester: { harvest: () => gate } });
    const started = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(["queued", "running"]).toContain(started.json().scan.status);
    expect(started.json().scan.current).toBe(false);
    const during = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/scans/scan-1",
      headers: ORG,
    });
    expect(["queued", "running"]).toContain(during.json().status);
    expect(during.json().current).toBe(false);
    expect(during.json().durationMs).toBeNull();
    release({
      inventory,
      coverage: [],
      coveredScopes: ["main:azure-inventory-all-resources"],
      facts: [],
    });
    const finished = await waitForScan(app, "scan-1", "succeeded");
    expect(finished.current).toBe(true);
    expect(finished.status).toBe("succeeded");
    await app.close();
  });
});

describe("scan merge with harvests", () => {
  it("keeps budget and reservation findings and spend coverage after POST then scan", async () => {
    const store = new MemoryStore(fixedClock);
    const app = buildApp(store, { ...TEST_APP_OPTIONS, harvester: fixtureHarvester(inventory) });
    const cost = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(cost.statusCode).toBe(200);
    const budgets = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/budgets",
      headers: ORG,
    });
    expect(budgets.statusCode).toBe(200);
    const commitments = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/commitments",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(commitments.statusCode).toBe(200);
    const before = store.snapshot("org-a");
    const budgetBefore = before.findings.filter((finding) => finding.checkId === NO_BUDGETS);
    const reservationBefore = before.findings.filter((finding) => finding.checkId === RESERVATION_USE);
    expect(budgetBefore.length).toBeGreaterThan(0);
    expect(reservationBefore.length).toBeGreaterThan(0);
    expect(
      before.coverage.find((entry) => entry.id === "main:azure-cost-spend-by-service")?.state,
    ).toBe("assessed");
    const started = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(started.statusCode).toBe(202);
    const finished = await waitForScan(app, started.json().scan.id, "succeeded");
    expect(finished.checks.map((check) => check.checkId).sort()).toEqual(
      [...AZURE_LAUNCH_CHECK_IDS].sort(),
    );
    const after = store.snapshot("org-a");
    expect(after.findings.filter((finding) => finding.checkId === NO_BUDGETS).length).toBe(
      budgetBefore.length,
    );
    expect(after.findings.filter((finding) => finding.checkId === RESERVATION_USE).length).toBe(
      reservationBefore.length,
    );
    expect(
      after.coverage.find((entry) => entry.id === "main:azure-cost-spend-by-service")?.state,
    ).toBe("assessed");
    await app.close();
  });
});

describe("scan merge across subscriptions", () => {
  async function scanSubscription(
    app: ReturnType<typeof buildApp>,
    subscriptionId: string,
    scanId: string,
  ) {
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId },
    });
    await waitForScan(app, scanId, "succeeded");
  }

  it("keeps other subscriptions' findings and coverage, and marks an empty subscription assessed", async () => {
    let harvested: Inventory = inventory;
    const app = buildApp(new MemoryStore(fixedClock), {
      ...TEST_APP_OPTIONS,
      harvester: {
        harvest: async () => ({
          inventory: harvested,
          coverage: [],
          coveredScopes: [],
          facts: factsFromManifest(MANIFEST),
        }),
      },
    });
    const read = async (route: string) =>
      (await app.inject({ method: "GET", url: `/v1/orgs/org-a/${route}`, headers: ORG })).json();
    await scanSubscription(app, "main", "scan-1");
    const mainFindings = (await read("findings")).findings as unknown[];
    expect(mainFindings.length).toBeGreaterThan(0);

    harvested = { ...inventory, resources: [] };
    await scanSubscription(app, "dev", "scan-2");
    const devEntries = (await read("coverage")).entries.filter(
      (entry: { subscriptionOrProject: string; checkId: string }) =>
        entry.subscriptionOrProject === "dev" && entry.checkId === "azure-waste-unattached-disks",
    );
    expect(devEntries).toHaveLength(1);
    expect(devEntries[0].state).toBe("assessed");
    expect((await read("findings")).findings).toHaveLength(mainFindings.length);

    harvested = inventory;
    await scanSubscription(app, "main", "scan-3");
    const afterMain = (await read("coverage")).entries.filter(
      (entry: { subscriptionOrProject: string; checkId: string }) =>
        entry.subscriptionOrProject === "dev" && entry.checkId === "azure-waste-unattached-disks",
    );
    expect(afterMain).toHaveLength(1);
    await app.close();
  });
});

type Json = { exportedAt: string; updatedAt: string; deletedAt: string; schedule: { lastTickAt: string } };

describe("untrusted client clock", () => {
  const SERVER_NOW = "2030-01-02T03:04:05.000Z";
  const CLIENT_NOW = "1999-01-01T00:00:00.000Z";
  const cases: {
    name: string;
    request: { method: "GET" | "POST" | "PUT"; url: string; payload?: object };
    headers?: Record<string, string>;
    read: (json: Json) => unknown;
  }[] = [
    { name: "export issues", request: { method: "GET", url: `/v1/orgs/org-a/export/issues?asOf=${CLIENT_NOW}` }, read: (j) => j.exportedAt },
    { name: "export cost", request: { method: "GET", url: `/v1/orgs/org-a/export/cost?asOf=${CLIENT_NOW}` }, read: (j) => j.exportedAt },
    {
      name: "settings",
      request: {
        method: "PUT",
        url: "/v1/orgs/org-a/settings",
        payload: { ownerTagKey: "owner", productionTagKey: "environment", productionTagValue: "prod", asOf: CLIENT_NOW },
      },
      read: (j) => j.updatedAt,
    },
    { name: "schedule tick", request: { method: "POST", url: "/v1/orgs/org-a/schedule/tick", payload: { now: CLIENT_NOW } }, read: (j) => j.schedule.lastTickAt },
    { name: "offboard", request: { method: "POST", url: "/v1/orgs/org-a/offboard", payload: { confirm: true, exportOffered: true, now: CLIENT_NOW } }, read: (j) => j.deletedAt },
    { name: "contract", headers: { "x-farside-operator": "op-token" }, request: { method: "PUT", url: "/v1/orgs/org-a/contract", payload: { plan: "starter", startDate: "2026-01-01T00:00:00.000Z", asOf: CLIENT_NOW } }, read: (j) => JSON.stringify(j) },
  ];

  it.each(cases)("ignores client time on $name", async ({ request, headers, read }) => {
    const app = buildApp(new MemoryStore(), { clock: () => SERVER_NOW, operatorToken: "op-token" });
    const response = await app.inject({ ...request, headers: headers ?? ORG });
    expect(response.statusCode).toBe(200);
    const value = String(read(response.json()));
    expect(value).not.toContain(CLIENT_NOW);
    expect(value).toContain("2030");
    await app.close();
  });
});

describe("server clock", () => {
  it("stamps a default-app scan with wall time and a real duration", async () => {
    const app = buildApp(new MemoryStore(), { harvester: fixtureHarvester(inventory) });
    const before = Date.now();
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    const scan = await waitForScan(app, "scan-1", "succeeded");
    expect(Math.abs(Date.parse(scan.startedAt ?? "") - before)).toBeLessThan(1000);
    expect(scan.durationMs).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});

async function waitForScan(
  app: ReturnType<typeof buildApp>,
  scanId: string,
  status: string,
): Promise<ScanView> {
  let scan: ScanView | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const listed = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
    });
    const scans = listed.json().scans as ScanView[];
    scan = scans.find((item) => item.id === scanId);
    if (scan?.status === status) {
      return scan;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`scan ${scanId} did not reach ${status}`);
}
