import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { fixtureHarvester } from "./scans.js";
import { addHours, decideTick } from "./scheduler.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const T0 = "2026-10-01T00:00:00.000Z";

describe("schedule decisions", () => {
  it("starts a system scan when the clock reaches nextRunAt", () => {
    expect(
      decideTick({
        now: T0,
        enabled: true,
        intervalHours: 24,
        retryLimit: 3,
        nextRunAt: T0,
        retryCount: 0,
        connection: {
          id: "conn-1",
          tenantId: "t",
          subscriptionId: "main",
          roles: [],
          createdAt: T0,
          healthy: true,
        },
        running: false,
        lastSystemFailed: false,
      }).action,
    ).toBe("started");
  });

  it("skips when a scan is already running", () => {
    expect(
      decideTick({
        now: T0,
        enabled: true,
        intervalHours: 24,
        retryLimit: 3,
        nextRunAt: T0,
        retryCount: 0,
        connection: {
          id: "conn-1",
          tenantId: "t",
          subscriptionId: "main",
          roles: [],
          createdAt: T0,
          healthy: true,
        },
        running: true,
        lastSystemFailed: false,
      }),
    ).toMatchObject({ action: "skipped_overlap", reason: "a scan is already running" });
  });

  it("retries a failed run within the limit", () => {
    expect(
      decideTick({
        now: T0,
        enabled: true,
        intervalHours: 24,
        retryLimit: 3,
        nextRunAt: T0,
        retryCount: 1,
        connection: {
          id: "conn-1",
          tenantId: "t",
          subscriptionId: "main",
          roles: [],
          createdAt: T0,
          healthy: true,
        },
        running: false,
        lastSystemFailed: true,
      }),
    ).toMatchObject({ action: "retried" });
  });

  it("records a missed run when a full interval has passed", () => {
    expect(
      decideTick({
        now: addHours(T0, 48),
        enabled: true,
        intervalHours: 24,
        retryLimit: 3,
        nextRunAt: T0,
        retryCount: 0,
        connection: {
          id: "conn-1",
          tenantId: "t",
          subscriptionId: "main",
          roles: [],
          createdAt: T0,
          healthy: true,
        },
        running: false,
        lastSystemFailed: false,
      }),
    ).toMatchObject({ action: "missed", reason: "scheduled run was missed" });
  });

  it("does not start when the connection is broken", () => {
    expect(
      decideTick({
        now: T0,
        enabled: true,
        intervalHours: 24,
        retryLimit: 3,
        nextRunAt: T0,
        retryCount: 0,
        connection: null,
        running: false,
        lastSystemFailed: false,
      }),
    ).toMatchObject({ action: "skipped_broken", attention: "connection needs attention" });
  });
});

describe("schedule routes", () => {
  const store = new MemoryStore();
  const inventory = inventoryFromManifest(MANIFEST);
  const app = buildApp(store, { harvester: fixtureHarvester(inventory) });

  afterAll(async () => {
    await app.close();
  });

  it("starts an unattended scan when the scheduled time arrives", async () => {
    await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: { tenantId: "tenant-1", subscriptionId: "main", asOf: T0 },
    });
    const due = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/schedule/tick",
      headers: ORG,
      payload: { now: addHours(T0, 24) },
    });
    expect(due.statusCode).toBe(200);
    expect(due.json().action).toBe("started");
    expect(due.json().scanStarted).toBe(true);
    expect(due.json().scan.actor).toBe("system");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (store.snapshot("org-a").scans.some((scan) => scan.status === "succeeded")) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it("skips and records overlap, then retries a failed run", async () => {
    store.putJob({
      orgId: "org-a",
      subscriptionId: "main",
      cloud: null,
      actor: "system",
      status: "running",
      complete: false,
      coveredScopes: [],
      createdAt: addHours(T0, 24),
      startedAt: addHours(T0, 24),
      finishedAt: null,
      error: null,
      durationMs: null,
      coverageSummary: { assessed: 0, unassessed: 0, undetermined: 0 },
      checks: [],
    });
    const overlap = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/schedule/tick",
      headers: ORG,
      payload: { now: addHours(T0, 48) },
    });
    expect(overlap.json().action).toBe("skipped_overlap");
    expect(overlap.json().record.action).toBe("skipped_overlap");
    const running = store.runningScan("org-a", "main");
    if (running) {
      store.patchJob("org-a", running.id, {
        status: "failed",
        complete: false,
        error: "Resource Graph call failed",
        finishedAt: addHours(T0, 48),
      });
    }
    const retry = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/schedule/tick",
      headers: ORG,
      payload: { now: addHours(T0, 72) },
    });
    expect(retry.json().action).toBe("retried");
    expect(retry.json().scanStarted).toBe(true);
  });

  it("does not start when the connection is marked unhealthy", async () => {
    const connection = store.snapshot("org-a").connections[0];
    expect(connection).toBeTruthy();
    store.patchConnection("org-a", connection!.id, { healthy: false });
    const broken = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/schedule/tick",
      headers: ORG,
      payload: { now: addHours(T0, 96) },
    });
    expect(broken.json().action).toBe("skipped_broken");
    expect(broken.json().attention).toBe("connection needs attention");
    expect(broken.json().scanStarted).toBe(false);
    const view = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/schedule",
      headers: ORG,
    });
    expect(view.json().attention).toBe("connection needs attention");
  });

  it("moves the next run when the interval changes in settings", async () => {
    store.patchConnection("org-a", store.snapshot("org-a").connections[0]!.id, { healthy: true });
    const saved = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/settings",
      headers: ORG,
      payload: {
        ownerTagKey: "owner",
        productionTagKey: "environment",
        productionTagValue: "prod",
        scanIntervalHours: 12,
        asOf: addHours(T0, 100),
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().scanIntervalHours).toBe(12);
    expect(saved.json().nextRunAt).toBe(addHours(addHours(T0, 100), 12));
    const early = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/schedule/tick",
      headers: ORG,
      payload: { now: addHours(T0, 106) },
    });
    expect(early.json().action).toBe("idle");
    const later = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/schedule/tick",
      headers: ORG,
      payload: { now: addHours(T0, 112) },
    });
    expect(later.json().action).toBe("started");
  });
});
