import { describe, expect, it, vi } from "vitest";
import { ScanRunner } from "./scans.js";
import { ScanScheduler } from "./scheduler.js";
import { runScheduledTick, settleWindowMs, withRemainingTime, type TickDeps } from "./scheduled.js";
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
    expect(settleWindowMs(240_000, 100_000)).toBe(98_000);
  });

  it("never exceeds the configured window", () => {
    expect(settleWindowMs(60_000, 280_000)).toBe(60_000);
  });

  it("is zero, not negative, when almost no time is left", () => {
    expect(settleWindowMs(240_000, 1_000)).toBe(0);
    expect(settleWindowMs(240_000, 0)).toBe(0);
  });
});

describe("settleWindowMs with a bad remaining time", () => {
  it("falls back to the configured window for NaN or Infinity, never abandoning everything", () => {
    expect(settleWindowMs(240_000, Number.NaN)).toBe(240_000);
    expect(settleWindowMs(240_000, Number.POSITIVE_INFINITY)).toBe(240_000);
  });
});

describe("withRemainingTime", () => {
  const base = { store: {}, scheduler: {}, clock, log: fakeLog() } as unknown as TickDeps;

  it("attaches the runtime's function, called with its own context", () => {
    const context = {
      deadline: 5_000,
      getRemainingTimeInMillis(this: { deadline: number }) {
        return this.deadline;
      },
    };
    const deps = withRemainingTime(base, context);
    expect(deps.remainingMs?.()).toBe(5_000);
    expect(deps.store).toBe(base.store);
  });

  it("returns the deps untouched when there is no context or no function", () => {
    expect(withRemainingTime(base)).toBe(base);
    expect(withRemainingTime(base, {})).toBe(base);
    expect(base.remainingMs).toBeUndefined();
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
