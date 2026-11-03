import { describe, expect, it } from "vitest";
import type { Inventory } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import { applyCoverageResults, recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { applyScanToIssues, type StoredIssue } from "./issues.js";
import { mergeScanCoverage, ScanRunner, type ScanJob } from "./scans.js";
import { MAX_SCHEDULE_RECORDS, ScanScheduler } from "./scheduler.js";
import { isVerified } from "./secrets.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MAX_SCANS_PER_ORG, MemoryStore } from "./store.js";
import { tickingClock } from "./test-clock.js";

const ORG = "org-bench";
const HEADERS = { [ORG_HEADER]: ORG, [ACTOR_HEADER]: "actor" };
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";
const BENCH_READ_MS = 250;
const BENCH_SAMPLES = 5;
const BENCH_OPTIONS = { retry: 2 } as const;
const BENCH_MERGE_MS = 1_000;
const BENCH_TICKS_MS = 30_000;

function bigInventory(count: number): Inventory {
  return {
    cloud: "azure",
    observedAt: OBSERVED_AT,
    resources: Array.from({ length: count }, (_, index) => ({
      resourceUri: `/subscriptions/sub-${index % 50}/resourceGroups/rg/providers/Microsoft.Compute/disks/d${index}`,
      resourceType: "Microsoft.Compute/disks",
      region: "eastus",
      displayName: `disk-${index}`,
      tags: { owner: "team", env: "prod" },
    })),
  };
}

function job(overrides: Partial<Omit<ScanJob, "id">> = {}): Omit<ScanJob, "id"> {
  return {
    orgId: ORG,
    subscriptionId: "sub-1",
    cloud: "azure",
    actor: "user",
    status: "succeeded",
    complete: true,
    coveredScopes: [],
    createdAt: OBSERVED_AT,
    startedAt: OBSERVED_AT,
    finishedAt: OBSERVED_AT,
    error: null,
    durationMs: 0,
    coverageSummary: { assessed: 0, unassessed: 0, undetermined: 0 },
    checks: [],
    ...overrides,
  };
}

async function medianMs(run: () => Promise<unknown> | unknown): Promise<number> {
  const samples: number[] = [];
  for (let sample = 0; sample < BENCH_SAMPLES; sample += 1) {
    samples.push(await elapsedMs(run));
  }
  return samples.sort((left, right) => left - right)[Math.floor(BENCH_SAMPLES / 2)] ?? 0;
}

async function elapsedMs(run: () => Promise<unknown> | unknown): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

describe("benchmark: reads do not copy the org", BENCH_OPTIONS, () => {
  it("serves GET /connections and GET /scans/:id on a 50k-resource org quickly", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    const inventory = bigInventory(50_000);
    await store.putInventory(ORG, inventory);
    await store.putFacts(
      ORG,
      inventory.resources.map((resource) => ({
        resourceUri: resource.resourceUri,
        fields: { sizeGb: 32 },
      })),
    );
    await store.putConnection(ORG, { tenantId: "tenant-1", subscriptionId: "sub-1" });
    const scan = await store.putJob(job());
    const get = (url: string) =>
      app.inject({ method: "GET", url: `/v1/orgs/${ORG}${url}`, headers: HEADERS });
    await get("/connections");

    const connections = await medianMs(() => get("/connections"));
    const byId = await medianMs(() => get(`/scans/${scan.id}`));

    expect(connections).toBeLessThan(BENCH_READ_MS);
    expect(byId).toBeLessThan(BENCH_READ_MS);
    expect((await get(`/scans/${scan.id}`)).json()).toMatchObject({ id: scan.id, current: true });
    await app.close();
  });
});

describe("benchmark: merges are linear", BENCH_OPTIONS, () => {
  it("merges 500 subscriptions x 20 checks and applies them to issues under a second", () => {
    let coverage: CoverageEntry[] = [];
    const duration = (() => {
      const start = performance.now();
      for (let sub = 0; sub < 500; sub += 1) {
        const next = Array.from({ length: 20 }, (_, check) =>
          recordCoverageScope({
            subscriptionOrProject: `sub-${sub}`,
            checkId: `azure-check-${check}`,
            state: "assessed",
          }),
        );
        coverage = mergeScanCoverage(
          coverage,
          next,
          new Set(next.map((entry) => entry.checkId)),
          `sub-${sub}`,
        );
      }
      return performance.now() - start;
    })();
    expect(duration).toBeLessThan(BENCH_MERGE_MS);
    expect(coverage).toHaveLength(10_000);

    const issues: StoredIssue[] = coverage.map((entry) => ({
      id: `${entry.checkId}:res:${entry.id}`,
      checkId: entry.checkId,
      resourceId: "res",
      scopeId: entry.id,
      cloud: "azure",
      subscriptionOrProject: entry.subscriptionOrProject,
      status: "open",
      evidence: {},
      coverage: "assessed",
      firstSeen: OBSERVED_AT,
      lastConfirmed: OBSERVED_AT,
    }));
    const applied = performance.now();
    const next = applyScanToIssues({
      issues,
      findings: [],
      coverage,
      scanId: "scan-1",
      observedAt: OBSERVED_AT,
    });
    expect(performance.now() - applied).toBeLessThan(BENCH_MERGE_MS);
    expect(
      next.every((issue) => issue.status === "closed" && issue.closingScanId === "scan-1"),
    ).toBe(true);
  });

  it("scales linearly with the number of results applied", () => {
    const results = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        subscriptionOrProject: `sub-${index}`,
        checkId: "azure-check",
        state: "assessed" as const,
      }));
    const median = (count: number) => {
      const input = results(count);
      const samples = [0, 1, 2].map(() => {
        const start = performance.now();
        applyCoverageResults([], input);
        return performance.now() - start;
      });
      return samples.sort((left, right) => left - right)[1] ?? 0;
    };
    median(25_000);
    expect(median(100_000) / Math.max(median(25_000), 0.05)).toBeLessThan(8);
  });

  it("keeps the last write for a repeated scope and moves it to the end", () => {
    const first = recordCoverageScope({
      subscriptionOrProject: "a",
      checkId: "c1",
      state: "assessed",
    });
    const other = recordCoverageScope({
      subscriptionOrProject: "a",
      checkId: "c2",
      state: "assessed",
    });
    const replaced = recordCoverageScope({
      subscriptionOrProject: "a",
      checkId: "c1",
      state: "unassessed",
      causeId: "not_run",
    });
    const merged = mergeScanCoverage([first, other], [first, replaced], new Set(["c1"]), "a");
    expect(merged.map((entry) => [entry.checkId, entry.state])).toEqual([
      ["c2", "assessed"],
      ["c1", "unassessed"],
    ]);
  });
});

describe("benchmark: history stays bounded", BENCH_OPTIONS, () => {
  it("keeps scans and schedule records within their caps over 1,000 ticks with unique ids", async () => {
    const store = new MemoryStore();
    const clock = tickingClock(Date.parse(OBSERVED_AT), 1000);
    const runner = new ScanRunner(
      store,
      {
        async harvest() {
          return {
            inventory: { cloud: "azure", observedAt: OBSERVED_AT, resources: [] },
            coverage: [],
            coveredScopes: [],
            facts: [],
          };
        },
      },
      {},
      clock,
    );
    const scheduler = new ScanScheduler(store, runner, clock);
    await store.putConnection(ORG, { tenantId: "tenant-1", subscriptionId: "sub-1" });
    await store.putSettings(ORG, { ...store.view(ORG).settings, scanScheduleEnabled: true });
    await scheduler.applySettings(ORG, OBSERVED_AT);

    const duration = await elapsedMs(async () => {
      for (let tick = 0; tick < 1_000; tick += 1) {
        await scheduler.tick(
          ORG,
          new Date(Date.parse(OBSERVED_AT) + (tick + 1) * 86_400_000).toISOString(),
        );
        await new Promise((resolve) => setImmediate(resolve));
      }
    });

    const { scans, schedule } = store.view(ORG);
    expect(duration).toBeLessThan(BENCH_TICKS_MS);
    expect(scans).toHaveLength(MAX_SCANS_PER_ORG);
    expect(schedule.records).toHaveLength(MAX_SCHEDULE_RECORDS);
    expect(new Set(scans.map((scan) => scan.id)).size).toBe(scans.length);
    expect(new Set(schedule.records.map((record) => record.id)).size).toBe(schedule.records.length);
    expect(scans.at(-1)?.id).toBe("scan-1000");
    expect(schedule.records.at(-1)?.id).toBe("sched-1000");
  });
});

describe("scan retention", () => {
  it("prunes the oldest settled scans but keeps in-flight scans and the current scan", async () => {
    const store = new MemoryStore();
    const running = await store.putJob(
      job({ status: "running", complete: false, subscriptionId: "sub-running" }),
    );
    const current = await store.putJob(job());
    for (let index = 0; index < MAX_SCANS_PER_ORG + 50; index += 1) {
      await store.putJob(job({ status: "failed", complete: false }));
    }
    const ids = store.view(ORG).scans.map((scan) => scan.id);
    expect(ids).toHaveLength(MAX_SCANS_PER_ORG);
    expect(ids).toContain(running.id);
    expect(ids).toContain(current.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await store.putJob(job())).id).toBe(`scan-${MAX_SCANS_PER_ORG + 53}`);
  });
});

describe("GET /scans paging", () => {
  async function seeded(count: number) {
    const store = new MemoryStore();
    const app = buildApp(store);
    for (let index = 0; index < count; index += 1) {
      await store.putJob(job());
    }
    const list = async (query = "") => {
      const response = await app.inject({
        method: "GET",
        url: `/v1/orgs/${ORG}/scans${query}`,
        headers: HEADERS,
      });
      return {
        status: response.statusCode,
        scans: (response.json().scans ?? []) as { id: string; current: boolean }[],
      };
    };
    return { app, list };
  }

  it("returns the newest 50 scans oldest-first by default and marks the current scan", async () => {
    const { app, list } = await seeded(120);
    const { scans } = await list();
    expect(scans).toHaveLength(50);
    expect(scans[0]?.id).toBe("scan-71");
    expect(scans.at(-1)).toMatchObject({ id: "scan-120", current: true });
    await app.close();
  });

  it("pages backwards with before and caps the page at 200", async () => {
    const { app, list } = await seeded(250);
    const older = await list("?limit=10&before=scan-100");
    expect(older.scans.map((scan) => scan.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `scan-${90 + index}`),
    );
    expect(older.scans.some((scan) => scan.current)).toBe(false);
    expect((await list("?limit=5000")).scans).toHaveLength(MAX_SCANS_PER_ORG);
    expect((await list("?before=scan-unknown")).status).toBe(400);
    await app.close();
  });

  it("includes the current scan when the page window would hide it", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await store.putJob(job());
    for (let index = 0; index < 60; index += 1) {
      await store.putJob(job({ status: "failed", complete: false }));
    }
    const response = await app.inject({ method: "GET", url: `/v1/orgs/${ORG}/scans`, headers: HEADERS });
    const scans = response.json().scans as { id: string; current: boolean }[];
    expect(scans).toHaveLength(51);
    expect(scans[0]).toMatchObject({ id: "scan-1", current: true });
    expect(scans.at(-1)?.id).toBe("scan-61");
    await app.close();
  });

  it("rejects a non-positive or non-numeric limit", async () => {
    const { app, list } = await seeded(1);
    expect((await list("?limit=0")).status).toBe(400);
    expect((await list("?limit=abc")).status).toBe(400);
    await app.close();
  });
});

describe("egress guard", () => {
  it("sends verified stored inventory as-is and walks bodies that were never scanned", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    const inventory = bigInventory(50_000);
    await store.putInventory(ORG, inventory);
    expect(isVerified(store.view(ORG).inventory)).toBe(true);
    expect(isVerified(structuredClone(inventory))).toBe(false);
    const get = (url: string) => app.inject({ method: "GET", url: `/v1/orgs/${ORG}${url}`, headers: HEADERS });
    expect((await get("/inventory")).statusCode).toBe(200);

    store.org(ORG).issues = [
      {
        id: "i1",
        checkId: "c",
        resourceId: "r",
        scopeId: "s",
        cloud: "azure",
        subscriptionOrProject: "sub-1",
        status: "open",
        evidence: { password: "hunter2" },
        coverage: "assessed",
        firstSeen: OBSERVED_AT,
        lastConfirmed: OBSERVED_AT,
      },
    ];
    const leaked = await get("/issues");
    expect(leaked.statusCode).toBe(500);
    expect(leaked.headers["content-type"]).toContain("application/problem+json");
    expect(leaked.body).not.toContain("hunter2");
    await app.close();
  });
});

describe("connection ids", () => {
  it("never reuses an id after a delete", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    const first = await store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-1" });
    const second = await store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-2" });
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/orgs/${ORG}/connections/${first.id}`,
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(204);
    const third = await store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-3" });
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(store.view(ORG).connections.map((connection) => connection.id)).toEqual([second.id, third.id]);
    await app.close();
  });
});
