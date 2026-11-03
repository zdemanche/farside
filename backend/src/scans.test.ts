import { afterAll, describe, expect, it } from "vitest";
import type { Inventory } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
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

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const inventory: Inventory = inventoryFromManifest(MANIFEST);
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("scan job runner", () => {
  it("succeeds in the background and stores inventory and coverage", async () => {
    const store = new MemoryStore();
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

  it("stores a mid-failure without marking the scan complete", async () => {
    const store = new MemoryStore();
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

  it("runs only one scan at a time per subscription", async () => {
    const store = new MemoryStore();
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
  const store = new MemoryStore();
  const app = buildApp(store, { harvester: fixtureHarvester(inventory) });

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
    const store = new MemoryStore();
    const app = buildApp(store, { harvester: fixtureHarvester(inventory) });
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
    expect(succeeded.durationMs).toBe(1);
    expect(succeeded.coverageSummary.assessed).toBeGreaterThan(0);
    expect(succeeded.checks.some((check) => check.state === "assessed")).toBe(true);
    expect(
      succeeded.checks.some(
        (check) => check.state === "unassessed" && typeof check.reason === "string",
      ),
    ).toBe(true);
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
    const store = new MemoryStore();
    const app = buildApp(store, {
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
    const store = new MemoryStore();
    let release!: (result: HarvestResult) => void;
    const gate = new Promise<HarvestResult>((resolve) => {
      release = resolve;
    });
    const app = buildApp(store, { harvester: { harvest: () => gate } });
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
