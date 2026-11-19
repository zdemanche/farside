import { describe, expect, it, vi } from "vitest";
import { ScanRunner } from "./scans.js";
import { ScanScheduler } from "./scheduler.js";
import { runScheduledTick, settleWindowMs } from "./scheduled.js";
import { MemoryStore } from "./store.js";

const NOW = "2026-10-01T00:00:00.000Z";
const clock = () => NOW;

function seeded(orgId: string) {
  const store = new MemoryStore(clock);
  const org = store.org(orgId);
  org.settings.scanScheduleEnabled = true;
  org.schedule.nextRunAt = NOW;
  org.connections.push({
    id: `conn-${orgId}`,
    tenantId: "tenant",
    subscriptionId: "main",
    roles: [],
    createdAt: NOW,
    healthy: true,
  });
  return store;
}

const fakeLog = () => ({ info: vi.fn(), error: vi.fn() });

describe("settleWindowMs", () => {
  it("is the configured window when the runtime reports nothing", () => {
    expect(settleWindowMs(240_000, undefined)).toBe(240_000);
  });

  it("is capped by the time the runtime has left, minus a margin", () => {
    expect(settleWindowMs(240_000, 100_000)).toBe(85_000);
  });

  it("never exceeds the configured window", () => {
    expect(settleWindowMs(60_000, 280_000)).toBe(60_000);
  });

  it("is zero, not negative, when almost no time is left", () => {
    expect(settleWindowMs(240_000, 5_000)).toBe(0);
    expect(settleWindowMs(240_000, 0)).toBe(0);
  });
});

describe("tick settle window follows the remaining Lambda time", () => {
  it("gives up straight away when the runtime has no time left, and says so", async () => {
    const store = seeded("org-a");
    const log = fakeLog();
    const runner = new ScanRunner(
      store,
      { harvest: () => new Promise(() => undefined) },
      {},
      clock,
      log,
    );
    const started = Date.now();
    await runScheduledTick({
      store,
      scheduler: new ScanScheduler(store, runner, clock),
      clock,
      log,
      settleMs: 60_000,
      pollMs: 5,
      remainingMs: () => 1_000,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    const abandoned = log.info.mock.calls.filter(
      ([fields]) => fields.event === "schedule.settle_abandoned",
    );
    expect(abandoned).toHaveLength(1);
  });

  it("logs one summary line per tick", async () => {
    const store = seeded("org-a");
    const log = fakeLog();
    const runner = new ScanRunner(
      store,
      { harvest: () => new Promise(() => undefined) },
      {},
      clock,
      log,
    );
    await runScheduledTick({
      store,
      scheduler: new ScanScheduler(store, runner, clock),
      clock,
      log,
      settleMs: 20,
      pollMs: 5,
      remainingMs: () => 250_000,
    });
    const summaries = log.info.mock.calls.filter(
      ([fields]) => fields.event === "schedule.tick.summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.[0]).toMatchObject({
      orgsTicked: 1,
      scansStarted: 1,
      abandoned: 1,
      remainingMs: 250_000,
    });
    expect(typeof summaries[0]?.[0].durationMs).toBe("number");
  });

  it("works without a remaining-time source, as before", async () => {
    const store = seeded("org-a");
    const log = fakeLog();
    const runner = new ScanRunner(
      store,
      { harvest: () => new Promise(() => undefined) },
      {},
      clock,
      log,
    );
    await runScheduledTick({
      store,
      scheduler: new ScanScheduler(store, runner, clock),
      clock,
      log,
      settleMs: 20,
      pollMs: 5,
    });
    const summary = log.info.mock.calls.find(
      ([fields]) => fields.event === "schedule.tick.summary",
    );
    expect(summary?.[0].remainingMs).toBeNull();
  });
});
