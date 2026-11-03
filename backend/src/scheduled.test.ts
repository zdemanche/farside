import { describe, expect, it, vi } from "vitest";
import { ScanRunner, defaultHarvester } from "./scans.js";
import { ScanScheduler } from "./scheduler.js";
import { runScheduledTick } from "./scheduled.js";
import { MemoryStore } from "./store.js";

const NOW = "2026-10-01T00:00:00.000Z";
const clock = () => NOW;

function seeded(orgIds: string[], nextRunAt: string | null) {
  const store = new MemoryStore(clock);
  for (const orgId of orgIds) {
    const org = store.org(orgId);
    org.settings.scanScheduleEnabled = true;
    org.schedule.nextRunAt = nextRunAt;
    org.connections.push({
      id: `conn-${orgId}`,
      tenantId: "tenant",
      subscriptionId: "main",
      roles: [],
      createdAt: NOW,
      healthy: true,
    });
  }
  return store;
}

function fakeLog() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("scheduled tick", () => {
  it("starts a due scan with no HTTP call and logs one line per org", async () => {
    const store = seeded(["org-a", "org-b"], NOW);
    store.org("org-b").schedule.nextRunAt = "2026-10-02T00:00:00.000Z";
    const log = fakeLog();
    const runner = new ScanRunner(store, defaultHarvester(clock), {}, clock, log);
    const summary = await runScheduledTick({
      store,
      scheduler: new ScanScheduler(store, runner, clock),
      clock,
      log,
      pollMs: 5,
    });
    expect(summary.orgs).toEqual([
      { orgId: "org-a", action: "started" },
      { orgId: "org-b", action: "idle" },
    ]);
    expect(store.org("org-a").scans.map((scan) => scan.status)).toEqual(["succeeded"]);
    expect(store.org("org-a").scans[0]?.actor).toBe("system");
    const decisions = log.info.mock.calls.filter(([fields]) => fields.event === "schedule.tick");
    expect(decisions.map(([fields]) => [fields.orgId, fields.action])).toEqual([
      ["org-a", "started"],
      ["org-b", "idle"],
    ]);
  });

  it("keeps ticking the other orgs when one throws", async () => {
    const store = seeded(["org-a", "org-b"], NOW);
    const log = fakeLog();
    const tick = vi.fn((orgId: string) => {
      if (orgId === "org-a") {
        throw new Error("boom");
      }
      return {
        action: "idle" as const,
        attention: null,
        record: null,
        scan: null,
        scanStarted: false,
        scans: [],
        schedule: store.org(orgId).schedule,
      };
    });
    const summary = await runScheduledTick({ store, scheduler: { tick }, clock, log });
    expect(summary.orgs).toEqual([{ orgId: "org-b", action: "idle" }]);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a" }), "schedule tick failed");
  });

  it("does not remove in-memory orgs when re-purging deleted ones", async () => {
    const store = seeded(["org-a"], NOW);
    expect(await store.repurgeDeleted(NOW)).toBe(0);
    expect(await store.orgIds()).toEqual(["org-a"]);
  });

  it("re-purges recently deleted orgs before ticking and keeps going if that sweep fails", async () => {
    const store = seeded(["org-a"], "2026-10-02T00:00:00.000Z");
    const log = fakeLog();
    const repurge = vi.spyOn(store, "repurgeDeleted").mockRejectedValue(new Error("purge down"));
    const runner = new ScanRunner(store, defaultHarvester(clock), {}, clock, log);
    const summary = await runScheduledTick({ store, scheduler: new ScanScheduler(store, runner, clock), clock, log });
    expect(repurge).toHaveBeenCalledWith(NOW);
    expect(summary.orgs).toEqual([{ orgId: "org-a", action: "idle" }]);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "deleted-org re-purge failed",
    );
  });

  it("still ticks every org when the retention sweep fails", async () => {
    const store = seeded(["org-a", "org-b"], "2026-10-02T00:00:00.000Z");
    vi.spyOn(store, "sweepRetention").mockRejectedValue(new Error("sweep down"));
    const log = fakeLog();
    const runner = new ScanRunner(store, defaultHarvester(clock), {}, clock, log);
    const summary = await runScheduledTick({ store, scheduler: new ScanScheduler(store, runner, clock), clock, log });
    expect(summary).toEqual({
      orgs: [
        { orgId: "org-a", action: "idle" },
        { orgId: "org-b", action: "idle" },
      ],
      retired: 0,
    });
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "retention sweep failed");
  });

  it("skips the demo org and returns after the settle window if a scan never ends", async () => {
    const store = seeded(["demo", "org-a"], NOW);
    const log = fakeLog();
    const runner = new ScanRunner(store, { harvest: () => new Promise(() => undefined) }, {}, clock, log);
    const summary = await runScheduledTick({
      store,
      scheduler: new ScanScheduler(store, runner, clock),
      clock,
      log,
      settleMs: 30,
      pollMs: 5,
    });
    expect(summary.orgs.map((entry) => entry.orgId)).toEqual(["org-a"]);
    expect(store.org("org-a").scans[0]?.status).toBe("running");
    const abandoned = log.info.mock.calls.filter(([fields]) => fields.event === "schedule.settle_abandoned");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.[0]).toMatchObject({ orgId: "org-a", scanIds: [store.org("org-a").scans[0]?.id] });
    expect(JSON.stringify(abandoned[0]?.[0])).not.toContain("main");
  });

  it("waits for the queued scan of a second subscription", async () => {
    const store = seeded(["org-a"], NOW);
    store.org("org-a").connections.push({
      id: "conn-second",
      tenantId: "tenant",
      subscriptionId: "second",
      roles: [],
      createdAt: NOW,
      healthy: true,
    });
    const log = fakeLog();
    const runner = new ScanRunner(store, defaultHarvester(clock), {}, clock, log);
    await runScheduledTick({
      store,
      scheduler: new ScanScheduler(store, runner, clock),
      clock,
      log,
      pollMs: 5,
    });
    const scans = store.org("org-a").scans;
    expect(scans.map((scan) => scan.subscriptionId).sort()).toEqual(["main", "second"]);
    expect(scans.map((scan) => scan.status)).toEqual(["succeeded", "succeeded"]);
  });
});
