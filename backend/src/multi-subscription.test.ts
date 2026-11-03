import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Finding, Inventory } from "@farside/scan-contracts";
import { MIXED_CURRENCY_CLOSER } from "./cost-total.js";
import { harvestCost, MONTH_ON_MONTH, SPEND_BY_SERVICE, TWO_MONTHS_CLOSER, type CostSnapshot } from "./cost.js";
import { recordCoverageScope } from "./coverage.js";
import { applyScanToIssues } from "./issues.js";
import { ScanRunner, type Harvester } from "./scans.js";
import { addHours, RETRY_DELAY_HOURS, ScanScheduler } from "./scheduler.js";
import { MemoryStore } from "./store.js";
import { fixedClock, FIXED_NOW } from "./test-clock.js";
import type { Clock } from "./clock.js";
import { silentLog, type LogSink } from "./observability.js";

const LONG_TIMEOUT_MS = 2_000_000_000;
const NEVER = new Promise<void>(() => undefined);
const FAKE_TIMEOUTS = { toFake: ["setTimeout", "clearTimeout"] } as const;

const openStores: MemoryStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.offboard(ORG, FIXED_NOW);
  }
  vi.useRealTimers();
});

const ORG = "org-a";
const DISK_TYPE = "Microsoft.Compute/disks";
const DISK_CHECK = "azure-waste-unattached-disks";

function diskUri(subscription: string, group: string, name: string): string {
  return `/subscriptions/${subscription}/resourceGroups/${group}/providers/${DISK_TYPE}/${name}`;
}

const TWO_SUBSCRIPTIONS = {
  "sub-a": [diskUri("sub-a", "rg-a", "web"), diskUri("sub-a", "rg-b", "web")],
  "sub-b": [diskUri("sub-b", "rg-a", "data")],
};

function harvesterFor(
  disks: Record<string, string[]>,
  options: { failFor?: string; gates?: Record<string, Promise<void>> } = {},
): Harvester {
  return {
    async harvest({ subscriptionId }) {
      await options.gates?.[subscriptionId];
      if (options.failFor === subscriptionId) {
        throw new Error("Resource Graph call failed");
      }
      const uris = disks[subscriptionId] ?? [];
      const inventory: Inventory = {
        cloud: "azure",
        observedAt: FIXED_NOW,
        resources: uris.map((resourceUri) => ({
          resourceUri,
          resourceType: DISK_TYPE,
          region: "eastus",
          displayName: resourceUri.split("/").pop() ?? "",
          tags: {},
        })),
      };
      return {
        inventory,
        coverage: [],
        coveredScopes: [],
        facts: uris.map((resourceUri) => ({
          resourceUri,
          fields: { diskState: "Unattached", sizeGb: 32 },
        })),
      };
    },
  };
}

async function scan(runner: ScanRunner, subscriptionId: string) {
  return runner.start({ orgId: ORG, subscriptionId, actor: "user" }).done;
}

async function settled(store: MemoryStore): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const busy = store
      .snapshot(ORG)
      .scans.some((job) => job.status === "queued" || job.status === "running");
    if (!busy) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("scans did not settle");
}

function diskIssues(store: MemoryStore) {
  return store.snapshot(ORG).issues.filter((issue) => issue.checkId === DISK_CHECK);
}

type MonthSpec = { month: string; amount: string; end?: string };

function figure(subscriptionId: string, currency: string, serviceName: string, spec: MonthSpec) {
  return {
    billingScope: `/subscriptions/${subscriptionId}`,
    currency,
    agreementType: "payg",
    serviceName,
    periodStart: `${spec.month}-01`,
    periodEnd: spec.end ?? `${spec.month}-30`,
    costAmount: spec.amount,
    provisional: false,
  };
}

function costSnapshot(
  subscriptionId: string,
  currency: string,
  input: {
    months?: MonthSpec[];
    services?: Record<string, MonthSpec>;
    changes?: { service: string; current: string; previous: string; currentMonth: string; previousMonth: string }[];
    serviceMonths?: Record<string, MonthSpec[]>;
  } = {},
): CostSnapshot {
  const months = (input.months ?? [{ month: "2026-10", amount: "10.00" }]).map((spec) =>
    figure(subscriptionId, currency, "all", spec),
  );
  const latest = Object.entries(input.services ?? { Storage: { month: "2026-10", amount: "10.00" } }).map(
    ([name, spec]) => figure(subscriptionId, currency, name, spec),
  );
  const fromChanges = (input.changes ?? []).flatMap((change) => [
    figure(subscriptionId, currency, change.service, { month: change.currentMonth, amount: change.current }),
    figure(subscriptionId, currency, change.service, { month: change.previousMonth, amount: change.previous }),
  ]);
  const explicit = Object.entries(input.serviceMonths ?? {}).flatMap(([name, specs]) =>
    specs.map((spec) => figure(subscriptionId, currency, name, spec)),
  );
  return {
    subscriptionId,
    billingScope: `/subscriptions/${subscriptionId}`,
    currency,
    agreementType: "payg",
    serviceMonths: input.serviceMonths ? explicit : [...fromChanges, ...latest.filter((row) => !fromChanges.some((change) => change.serviceName === row.serviceName && change.periodStart === row.periodStart))],
    periodStart: months[0]?.periodStart ?? "",
    periodEnd: months.at(-1)?.periodEnd ?? "",
    asOf: FIXED_NOW,
    provisionalDate: null,
    services: Object.entries(input.services ?? { Storage: { month: "2026-10", amount: "10.00" } }).map(
      ([name, spec]) => figure(subscriptionId, currency, name, spec),
    ),
    months,
    monthOnMonth: (input.changes ?? []).map((change) => ({
      billingScope: `/subscriptions/${subscriptionId}`,
      currency,
      agreementType: "payg",
      serviceName: change.service,
      currentMonth: change.currentMonth,
      previousMonth: change.previousMonth,
      currentMonthCost: change.current,
      previousMonthCost: change.previous,
      deltaAmount: "0.00",
      deltaPercent: "0.00",
    })),
  };
}

describe("per-subscription state", () => {
  it("keeps both subscriptions' resources, facts and open issues after scanning A then B", async () => {
    const store = new MemoryStore(fixedClock);
    const runner = new ScanRunner(store, harvesterFor(TWO_SUBSCRIPTIONS), {}, fixedClock);
    await scan(runner, "sub-a");
    await scan(runner, "sub-b");
    const org = store.snapshot(ORG);
    expect(org.inventories.azure?.resources.map((row) => row.resourceUri).sort()).toEqual(
      [...TWO_SUBSCRIPTIONS["sub-a"], ...TWO_SUBSCRIPTIONS["sub-b"]].sort(),
    );
    expect(org.facts).toHaveLength(3);
    const issues = diskIssues(store);
    expect(issues).toHaveLength(3);
    expect(issues.every((issue) => issue.status === "open")).toBe(true);
  });

  it("replaces only the rescanned subscription's resources", async () => {
    const store = new MemoryStore(fixedClock);
    await scan(new ScanRunner(store, harvesterFor(TWO_SUBSCRIPTIONS), {}, fixedClock), "sub-a");
    await scan(new ScanRunner(store, harvesterFor(TWO_SUBSCRIPTIONS), {}, fixedClock), "sub-b");
    const shrunk = { ...TWO_SUBSCRIPTIONS, "sub-a": [diskUri("sub-a", "rg-a", "web")] };
    await scan(new ScanRunner(store, harvesterFor(shrunk), {}, fixedClock), "sub-a");
    expect(store.snapshot(ORG).inventories.azure?.resources).toHaveLength(2);
    const byStatus = diskIssues(store).map((issue) => issue.status);
    expect(byStatus.filter((status) => status === "open")).toHaveLength(2);
    expect(byStatus.filter((status) => status === "closed")).toHaveLength(1);
  });

  it("matches Azure subscription ids case-insensitively when rescanning", async () => {
    const store = new MemoryStore(fixedClock);
    const upper = { "sub-a": [diskUri("SUB-A", "rg-a", "web")] };
    const lower = { "sub-a": [diskUri("sub-a", "rg-a", "web")] };
    await scan(new ScanRunner(store, harvesterFor(upper), {}, fixedClock), "sub-a");
    await scan(new ScanRunner(store, harvesterFor(lower), {}, fixedClock), "sub-a");
    expect(store.snapshot(ORG).inventories.azure?.resources).toHaveLength(1);
  });

  it("totals cost per month across subscriptions even when period ends differ", () => {
    const store = new MemoryStore(fixedClock);
    store.putCost(ORG, costSnapshot("sub-a", "USD", { months: [{ month: "2026-10", amount: "10.00", end: "2026-10-31" }] }));
    store.putCost(ORG, costSnapshot("sub-b", "USD", { months: [{ month: "2026-10", amount: "5.25", end: "2026-10-30" }] }));
    expect(store.costsOf(ORG).map((row) => row.subscriptionId)).toEqual(["sub-a", "sub-b"]);
    const total = store.snapshot(ORG).cost;
    expect(total?.months).toHaveLength(1);
    expect(total?.months[0]).toMatchObject({ costAmount: "15.25", periodEnd: "2026-10-31" });
    expect(total?.services.map((row) => row.costAmount)).toEqual(["20.00"]);
    store.putCost(ORG, null, "sub-a");
    expect(store.snapshot(ORG).cost?.months[0]?.costAmount).toBe("5.25");
  });

  it("sorts months across subscriptions and recomputes month-on-month from combined figures", () => {
    const store = new MemoryStore(fixedClock);
    store.putCost(
      ORG,
      costSnapshot("sub-b", "USD", {
        months: [
          { month: "2026-09", amount: "4.00" },
          { month: "2026-10", amount: "9.00" },
        ],
        services: { Storage: { month: "2026-10", amount: "3.00" }, Compute: { month: "2026-10", amount: "6.00" } },
        changes: [{ service: "Compute", currentMonth: "2026-10", previousMonth: "2026-09", current: "6.00", previous: "4.00" }],
      }),
    );
    store.putCost(
      ORG,
      costSnapshot("sub-a", "USD", {
        months: ["06", "07", "08", "09", "10"].map((month) => ({ month: `2026-${month}`, amount: "10.00" })),
        services: { Storage: { month: "2026-10", amount: "10.00" } },
        changes: [{ service: "Storage", currentMonth: "2026-10", previousMonth: "2026-09", current: "10.00", previous: "10.00" }],
      }),
    );
    const total = store.snapshot(ORG).cost;
    expect(total?.months.map((row) => row.periodStart)).toEqual(
      ["06", "07", "08", "09", "10"].map((month) => `2026-${month}-01`),
    );
    expect(total?.months.at(-1)).toMatchObject({ periodStart: "2026-10-01", costAmount: "19.00" });
    expect(total?.periodEnd).toBe("2026-10-30");
    const byService = Object.fromEntries((total?.monthOnMonth ?? []).map((row) => [row.serviceName, row]));
    expect(byService.Storage).toMatchObject({ currentMonthCost: "13.00", previousMonthCost: "10.00" });
    expect(byService.Compute).toMatchObject({ currentMonthCost: "6.00", previousMonthCost: "4.00" });
  });

  it("ignores a subscription with no cost figures when totalling and checking currency", () => {
    const store = new MemoryStore(fixedClock);
    store.putCost(ORG, { ...costSnapshot("sub-empty", "", { months: [], services: {} }), currency: "" });
    store.putCost(ORG, costSnapshot("sub-b", "USD"));
    const org = store.snapshot(ORG);
    expect(org.cost?.currency).toBe("USD");
    expect(org.coverage.filter((entry) => entry.closer === MIXED_CURRENCY_CLOSER)).toEqual([]);
  });

  it("never adds across currencies and heals coverage from each stored snapshot", () => {
    const store = new MemoryStore(fixedClock);
    store.putCost(ORG, costSnapshot("sub-a", "USD"));
    store.putCost(ORG, costSnapshot("sub-b", "EUR"));
    const mixed = store.snapshot(ORG);
    expect(mixed.cost).toBeNull();
    expect(store.costsOf(ORG)).toHaveLength(2);
    const spend = mixed.coverage.filter((entry) => entry.checkId === SPEND_BY_SERVICE);
    expect(spend.map((entry) => [entry.state, entry.closer])).toEqual([
      ["undetermined", MIXED_CURRENCY_CLOSER],
      ["undetermined", MIXED_CURRENCY_CLOSER],
    ]);
    store.putCoverage(ORG, mixed.coverage.map((entry) => ({ ...entry, state: "assessed" as const })));
    expect(
      store.snapshot(ORG).coverage.filter((entry) => entry.checkId === SPEND_BY_SERVICE).every(
        (entry) => entry.state === "undetermined",
      ),
    ).toBe(true);
    store.putCost(ORG, costSnapshot("sub-b", "USD"));
    const healed = store.snapshot(ORG).coverage;
    expect(healed.filter((entry) => entry.checkId === SPEND_BY_SERVICE).every((entry) => entry.state === "assessed")).toBe(
      true,
    );
    const monthOnMonth = healed.filter((entry) => entry.checkId === MONTH_ON_MONTH);
    expect(monthOnMonth.map((entry) => [entry.state, entry.closer])).toEqual([
      ["undetermined", TWO_MONTHS_CLOSER],
      ["undetermined", TWO_MONTHS_CLOSER],
    ]);
  });
});

describe("disconnecting a subscription", () => {
  it("drops its inventory, facts and cost but keeps the others", async () => {
    const store = new MemoryStore(fixedClock);
    const connectionA = store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-a" });
    store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-b" });
    const runner = new ScanRunner(store, harvesterFor(TWO_SUBSCRIPTIONS), {}, fixedClock);
    await scan(runner, "sub-a");
    await scan(runner, "sub-b");
    store.putCost(ORG, costSnapshot("sub-a", "USD"));
    store.putCost(ORG, costSnapshot("sub-b", "USD", { months: [{ month: "2026-10", amount: "5.00" }] }));
    expect(store.deleteConnection(ORG, connectionA.id)).toBe(true);
    const org = store.snapshot(ORG);
    expect(org.inventories.azure?.resources.map((row) => row.resourceUri)).toEqual(
      TWO_SUBSCRIPTIONS["sub-b"],
    );
    expect(org.facts.map((row) => row.resourceUri)).toEqual(TWO_SUBSCRIPTIONS["sub-b"]);
    expect(store.costsOf(ORG).map((row) => row.subscriptionId)).toEqual(["sub-b"]);
    expect(org.cost?.months[0]?.costAmount).toBe("5.00");
  });
});

describe("concurrent scans in one org", () => {
  it("runs them one after another so a slow scan cannot overwrite its sibling", async () => {
    const store = new MemoryStore(fixedClock);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const runner = new ScanRunner(
      store,
      harvesterFor(TWO_SUBSCRIPTIONS, { gates: { "sub-a": gate } }),
      {},
      fixedClock,
    );
    const first = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "system" });
    const second = runner.start({ orgId: ORG, subscriptionId: "sub-b", actor: "system" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getJob(ORG, first.job.id)?.status).toBe("running");
    expect(store.getJob(ORG, second.job.id)?.status).toBe("queued");
    open();
    await Promise.all([first.done, second.done]);
    const issues = diskIssues(store);
    expect(issues).toHaveLength(3);
    expect(issues.every((issue) => issue.status === "open")).toBe(true);
    expect(
      store
        .snapshot(ORG)
        .findings.filter((finding) => finding.checkId === DISK_CHECK && finding.result === "fail"),
    ).toHaveLength(3);
  });

  it("cancels quietly when the org is offboarded after a cost harvest", async () => {
    const store = new MemoryStore(fixedClock);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new ScanRunner(
      store,
      harvesterFor(TWO_SUBSCRIPTIONS),
      {
        costClient: {
          query: async () => {
            await gate;
            return { rows: [] };
          },
        },
      },
      fixedClock,
    );
    const { done } = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" });
    await new Promise((resolve) => setImmediate(resolve));
    store.offboard(ORG, FIXED_NOW);
    release();
    expect((await done).status).toBe("cancelled");
    expect(store.hasOrg(ORG)).toBe(false);
  });
});

function scheduled(
  harvester: Harvester,
  clock: Clock = fixedClock,
  log: LogSink = silentLog,
  timeoutMs: number = LONG_TIMEOUT_MS,
) {
  const store = new MemoryStore(clock);
  openStores.push(store);
  const runner = new ScanRunner(store, harvester, {}, clock, log, timeoutMs);
  const scheduler = new ScanScheduler(store, runner, clock, log);
  store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-a" });
  store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-b" });
  store.org(ORG).settings.scanScheduleEnabled = true;
  scheduler.applySettings(ORG, clock());
  return { store, runner, scheduler };
}

describe("scheduler with several connections", () => {
  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMEOUTS);
  });

  it("starts one scan per healthy connection and skips the unhealthy one", async () => {
    const { store, scheduler } = scheduled(harvesterFor(TWO_SUBSCRIPTIONS));
    const broken = store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-c" });
    store.patchConnection(ORG, broken.id, { healthy: false });
    const tick = scheduler.tick(ORG, addHours(FIXED_NOW, 24));
    expect(tick.action).toBe("started");
    expect(tick.scans.map((item) => item.scan.subscriptionId)).toEqual(["sub-a", "sub-b"]);
    expect(tick.scans.every((item) => item.started)).toBe(true);
    expect(store.snapshot(ORG).schedule.records.map((record) => record.subscriptionId)).toEqual([
      "sub-a",
      "sub-b",
    ]);
    expect(scheduler.tick(ORG, addHours(FIXED_NOW, 24)).action).toBe("idle");
    await settled(store);
  });

  it("skips as overlap only when every healthy subscription is already scanning", async () => {
    const { store, runner, scheduler } = scheduled(harvesterFor(TWO_SUBSCRIPTIONS));
    runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" });
    const tick = scheduler.tick(ORG, addHours(FIXED_NOW, 24));
    expect(tick.action).toBe("started");
    expect(tick.scans.map((item) => item.started)).toEqual([false, true]);
    await settled(store);
  });

  it("retries only the subscription whose last scheduled scan failed", async () => {
    const { store, scheduler } = scheduled(harvesterFor(TWO_SUBSCRIPTIONS, { failFor: "sub-a" }));
    const first = scheduler.tick(ORG, addHours(FIXED_NOW, 24));
    expect(first.scans).toHaveLength(2);
    await settled(store);
    const retry = scheduler.tick(ORG, addHours(FIXED_NOW, 48));
    expect(retry.action).toBe("retried");
    expect(retry.scans.map((item) => item.scan.subscriptionId)).toEqual(["sub-a"]);
    expect(store.snapshot(ORG).schedule.retryCounts).toEqual({ "sub-a": 1 });
    await settled(store);
  });
});

describe("full-URI issue identity", () => {
  const scope = {
    id: `main:${DISK_CHECK}`,
    cloud: "azure" as const,
    subscriptionOrProject: "main",
  };
  const coverage = [
    recordCoverageScope({ subscriptionOrProject: "main", checkId: DISK_CHECK, state: "assessed" }),
  ];
  const fail = (resourceUri: string): Finding => ({
    checkId: DISK_CHECK,
    result: "fail",
    evidence: { fields: { resourceUri, diskId: "web" } },
    scope,
  });
  const legacyFinding: Finding = { ...fail("x"), evidence: { fields: { diskId: "web" } } };
  const apply = (
    issues: ReturnType<typeof applyScanToIssues>,
    findings: Finding[],
    observedAt: string,
    checkIds?: string[],
  ) =>
    applyScanToIssues({
      issues,
      findings,
      coverage,
      scanId: "scan",
      observedAt,
      ...(checkIds ? { checkIds } : {}),
    });

  it("keeps same-named resources in different resource groups as separate issues", () => {
    const issues = apply(
      [],
      [fail(diskUri("main", "rg-a", "web")), fail(diskUri("main", "rg-b", "web"))],
      FIXED_NOW,
    );
    expect(issues.map((issue) => issue.evidence.resourceUri).sort()).toEqual([
      diskUri("main", "rg-a", "web"),
      diskUri("main", "rg-b", "web"),
    ]);
  });

  it("re-keys an issue stored under the short name once and stays stable afterwards", () => {
    const legacy = apply([], [legacyFinding], FIXED_NOW);
    expect(legacy[0]?.id).toBe(`${DISK_CHECK}:web:main:${DISK_CHECK}`);
    const later = addHours(FIXED_NOW, 24);
    const finding = fail(diskUri("main", "rg-a", "web"));
    const next = apply(legacy, [finding], later);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      resourceId: diskUri("main", "rg-a", "web"),
      status: "open",
      firstSeen: FIXED_NOW,
      lastConfirmed: later,
    });
    const third = apply(next, [finding], addHours(FIXED_NOW, 48));
    expect(third).toHaveLength(1);
    expect(third[0]?.id).toBe(next[0]?.id);
    expect(third[0]?.firstSeen).toBe(FIXED_NOW);
  });

  it("re-keys a closed legacy issue and reopens it when the finding returns", () => {
    const closed = apply(apply([], [legacyFinding], FIXED_NOW), [], addHours(FIXED_NOW, 24));
    expect(closed[0]).toMatchObject({ status: "closed", closingScanId: "scan" });
    const reopened = apply(closed, [fail(diskUri("main", "rg-a", "web"))], addHours(FIXED_NOW, 48));
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({
      id: `${DISK_CHECK}:${diskUri("main", "rg-a", "web")}:main:${DISK_CHECK}`,
      status: "open",
      firstSeen: FIXED_NOW,
      lastConfirmed: addHours(FIXED_NOW, 48),
    });
    expect(reopened[0]).not.toHaveProperty("closingScanId");
  });

  it("keeps the already re-keyed issue when a legacy twin also exists", () => {
    const finding = fail(diskUri("main", "rg-a", "web"));
    const rekeyed = apply(apply([], [legacyFinding], FIXED_NOW), [finding], FIXED_NOW);
    const withTwin = [...rekeyed, ...apply([], [legacyFinding], addHours(FIXED_NOW, 1))];
    const next = apply(withTwin, [finding], addHours(FIXED_NOW, 24));
    const open = next.filter((issue) => issue.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]?.resourceId).toBe(diskUri("main", "rg-a", "web"));
  });

  it("does not re-key issues of checks outside the checkIds limit", () => {
    const legacy = apply([], [legacyFinding], FIXED_NOW);
    const next = apply(legacy, [fail(diskUri("main", "rg-a", "web"))], FIXED_NOW, ["azure-cost-subscriptions-without-budgets"]);
    expect(next).toEqual(legacy);
  });
});

describe("scheduler hardening", () => {
  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMEOUTS);
  });

  it("fails a hung harvest with harvest_timeout and lets the org queue move on", async () => {
    vi.useRealTimers();
    const store = new MemoryStore(fixedClock);
    openStores.push(store);
    const runner = new ScanRunner(store, harvesterFor(TWO_SUBSCRIPTIONS, { gates: { "sub-a": NEVER } }), {}, fixedClock, silentLog, 20);
    const first = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "system" });
    const second = runner.start({ orgId: ORG, subscriptionId: "sub-b", actor: "system" });
    expect(await first.done).toMatchObject({ status: "failed", error: "harvest_timeout" });
    expect((await second.done).status).toBe("succeeded");
  });

  it("treats a running job older than the timeout as failed so it cannot block a new scan", () => {
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const clock: Clock = () => new Date(now).toISOString();
    const store = new MemoryStore(clock);
    openStores.push(store);
    const runner = new ScanRunner(store, harvesterFor(TWO_SUBSCRIPTIONS, { gates: { "sub-a": NEVER } }), {}, clock, silentLog, 60_000);
    const stuck = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" });
    expect(runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" }).started).toBe(false);
    now += 61_000;
    const next = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" });
    expect(next.started).toBe(true);
    expect(next.job.id).not.toBe(stuck.job.id);
    expect(store.getJob(ORG, stuck.job.id)).toMatchObject({ status: "failed", error: "harvest_timeout" });
  });

  it("retries a failed scan one retry delay later, only for the failed subscription", async () => {
    let now = FIXED_NOW;
    const { store, scheduler } = scheduled(harvesterFor(TWO_SUBSCRIPTIONS, { failFor: "sub-a" }), () => now);
    now = addHours(FIXED_NOW, 24);
    expect(scheduler.tick(ORG, now).action).toBe("started");
    await settled(store);
    expect(store.snapshot(ORG).schedule.nextRunAt).toBe(addHours(now, RETRY_DELAY_HOURS));
    expect(scheduler.tick(ORG, addHours(now, RETRY_DELAY_HOURS / 2)).action).toBe("idle");
    now = addHours(now, RETRY_DELAY_HOURS);
    const retry = scheduler.tick(ORG, now);
    expect(retry.action).toBe("retried");
    expect(retry.scans.map((item) => item.scan.subscriptionId)).toEqual(["sub-a"]);
    await settled(store);
  });

  it("fails a stuck job at tick time, flags it, and starts a fresh scan", () => {
    let now = FIXED_NOW;
    const { store, runner, scheduler } = scheduled(
      harvesterFor(TWO_SUBSCRIPTIONS, { gates: { "sub-a": NEVER, "sub-b": NEVER } }),
      () => now,
      silentLog,
      60_000,
    );
    const stuck = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" });
    now = addHours(FIXED_NOW, 24);
    const tick = scheduler.tick(ORG, now);
    expect(store.getJob(ORG, stuck.job.id)).toMatchObject({ status: "failed", error: "harvest_timeout" });
    expect(tick.attention).toBe("scan stuck: a scan ran past the timeout and was marked failed");
    expect(tick.action).toBe("started");
    expect(tick.scans.every((item) => item.started)).toBe(true);
  });

  it("shares one budget across the main harvest and the cost harvest", async () => {
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const clock: Clock = () => new Date(now).toISOString();
    const store = new MemoryStore(clock);
    openStores.push(store);
    const inner = harvesterFor(TWO_SUBSCRIPTIONS);
    const harvester: Harvester = {
      harvest: async (input) => {
        now += 6 * 60_000;
        return inner.harvest(input);
      },
    };
    const runner = new ScanRunner(store, harvester, { costClient: { query: () => NEVER as never } }, clock, silentLog, 10 * 60_000);
    const { job } = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" });
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1);
    expect(store.getJob(ORG, job.id)?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getJob(ORG, job.id)).toMatchObject({ status: "failed", error: "harvest_timeout" });
  });

  it("keeps a scan alive when its harvests together fit the budget, even if a tick arrives mid-scan", async () => {
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const clock: Clock = () => new Date(now).toISOString();
    const store = new MemoryStore(clock);
    openStores.push(store);
    const inner = harvesterFor(TWO_SUBSCRIPTIONS);
    const harvester: Harvester = {
      harvest: async (input) => {
        now += 3 * 60_000;
        return inner.harvest(input);
      },
    };
    let expiredMidScan: unknown[] = [];
    const runner: ScanRunner = new ScanRunner(
      store,
      harvester,
      {
        costClient: {
          query: async () => {
            now += 3 * 60_000;
            expiredMidScan = runner.expireStaleScans(ORG, clock());
            return { rows: [] };
          },
        },
      },
      clock,
      silentLog,
      10 * 60_000,
    );
    const { done } = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" });
    expect((await done).status).toBe("succeeded");
    expect(expiredMidScan).toEqual([]);
  });

  it("goes back to the regular cadence when a retry comes due with nothing left to retry", async () => {
    let now = FIXED_NOW;
    const { store, scheduler } = scheduled(harvesterFor(TWO_SUBSCRIPTIONS, { failFor: "sub-a" }), () => now);
    now = addHours(FIXED_NOW, 24);
    scheduler.tick(ORG, now);
    await settled(store);
    const regular = addHours(now, 24);
    expect(store.snapshot(ORG).schedule).toMatchObject({ retryAt: addHours(now, 1), regularRunAt: regular });
    store.snapshot(ORG).scans.forEach((job) => store.patchJob(ORG, job.id, { status: "succeeded" }));
    const due = scheduler.tick(ORG, addHours(now, 1));
    expect(due.action).toBe("idle");
    expect(store.snapshot(ORG).schedule).toMatchObject({ retryAt: null, nextRunAt: regular, retryCounts: {} });
  });

  it("does not push the regular cadence later after a retry", async () => {
    let now = FIXED_NOW;
    const { store, scheduler } = scheduled(harvesterFor(TWO_SUBSCRIPTIONS, { failFor: "sub-a" }), () => now);
    now = addHours(FIXED_NOW, 24);
    scheduler.tick(ORG, now);
    await settled(store);
    const regular = addHours(now, 24);
    now = addHours(now, 1);
    expect(scheduler.tick(ORG, now).action).toBe("retried");
    await settled(store);
    expect(store.snapshot(ORG).schedule.regularRunAt).toBe(regular);
    expect(store.snapshot(ORG).schedule.retryAt).toBe(addHours(now, 1));
  });

  describe("decision metrics", () => {
    function capture() {
      const lines: Record<string, unknown>[] = [];
      const log: LogSink = { info: (line: unknown) => void lines.push(line as Record<string, unknown>), error: () => undefined };
      return { lines, log };
    }

    it("logs one decision line without subscription ids", async () => {
      const { lines, log } = capture();
      const { store, scheduler } = scheduled(harvesterFor(TWO_SUBSCRIPTIONS), fixedClock, log);
      expect(scheduler.tick(ORG, FIXED_NOW).action).toBe("idle");
      const started = scheduler.tick(ORG, addHours(FIXED_NOW, 24));
      await settled(store);
      const decisions = lines.filter((line) => line.event === "scheduler.decision");
      expect(decisions).toEqual([
        { event: "scheduler.decision", decision: "idle", orgId: ORG },
        { event: "scheduler.decision", decision: "started", orgId: ORG, scanId: started.scan?.id },
      ]);
      expect(JSON.stringify(decisions)).not.toContain("sub-");
    });

    it("adds EMF fields only when FARSIDE_EMIT_EMF=1", () => {
      const { lines, log } = capture();
      const { scheduler } = scheduled(harvesterFor(TWO_SUBSCRIPTIONS), fixedClock, log);
      vi.stubEnv("FARSIDE_EMIT_EMF", "1");
      try {
        scheduler.tick(ORG, FIXED_NOW);
      } finally {
        vi.unstubAllEnvs();
      }
      scheduler.tick(ORG, FIXED_NOW);
      const [emf, plain] = lines.filter((line) => line.event === "scheduler.decision");
      expect(emf).toMatchObject({
        Decision: "idle",
        Decisions: 1,
        _aws: {
          Timestamp: Date.parse(FIXED_NOW),
          CloudWatchMetrics: [
            {
              Namespace: "Farside/Scheduler",
              Dimensions: [["Decision"]],
              Metrics: [{ Name: "Decisions", Unit: "Count" }],
            },
          ],
        },
      });
      expect(plain).not.toHaveProperty("_aws");
    });
  });
});

describe("combined month-on-month with a service that stops", () => {
  it("keeps the previous month of a service one subscription stopped using", () => {
    const store = new MemoryStore(fixedClock);
    store.putCost(
      ORG,
      costSnapshot("sub-a", "USD", {
        months: [
          { month: "2026-09", amount: "10.00" },
          { month: "2026-10", amount: "10.00" },
        ],
        serviceMonths: {
          Storage: [
            { month: "2026-09", amount: "10.00" },
            { month: "2026-10", amount: "10.00" },
          ],
        },
      }),
    );
    store.putCost(
      ORG,
      costSnapshot("sub-b", "USD", {
        months: [{ month: "2026-09", amount: "5.00" }],
        services: {},
        serviceMonths: { Storage: [{ month: "2026-09", amount: "5.00" }] },
      }),
    );
    expect(store.snapshot(ORG).cost?.monthOnMonth).toEqual([
      expect.objectContaining({
        serviceName: "Storage",
        previousMonthCost: "15.00",
        currentMonthCost: "10.00",
        deltaPercent: "-33.33",
      }),
    ]);
  });

  it("stores a service's earlier month on the harvested snapshot even when it has no current-month spend", async () => {
    const row = (date: string, serviceName: string, costAmount: string) => ({ date, serviceName, costAmount, currency: "USD" });
    const result = await harvestCost({
      client: {
        query: async () => ({
          rows: [
            row("2026-09-01", "Storage", "10.00"),
            row("2026-09-01", "Compute", "4.00"),
            row("2026-10-01", "Storage", "10.00"),
            row("2026-11-01", "Storage", "1.00"),
          ],
        }),
      },
      subscriptionId: "sub-a",
      billingScope: "/subscriptions/sub-a",
      agreementType: "payg",
    });
    expect(result.ok && result.snapshot.serviceMonths.map((item) => `${item.serviceName}:${item.periodStart.slice(0, 7)}`).sort()).toEqual([
      "Compute:2026-09",
      "Storage:2026-09",
      "Storage:2026-10",
    ]);
  });
});

describe("disconnect during a scan", () => {
  it("writes nothing for a subscription disconnected mid-scan and cancels the queued one before harvesting", async () => {
    const store = new MemoryStore(fixedClock);
    const connectionA = store.putConnection(ORG, { tenantId: "t", subscriptionId: "sub-a" });
    const connectionB = store.putConnection(ORG, { tenantId: "t", subscriptionId: "SUB-B" });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const harvester = harvesterFor(TWO_SUBSCRIPTIONS, { gates: { "sub-a": gate } });
    const harvest = vi.spyOn(harvester, "harvest");
    const runner = new ScanRunner(store, harvester, {}, fixedClock);
    const first = runner.start({ orgId: ORG, subscriptionId: "sub-a", actor: "user" });
    const second = runner.start({ orgId: ORG, subscriptionId: "sub-b", actor: "user" });
    await new Promise((resolve) => setImmediate(resolve));
    store.deleteConnection(ORG, connectionA.id);
    store.deleteConnection(ORG, connectionB.id);
    open();
    expect((await first.done).status).toBe("cancelled");
    expect((await second.done).status).toBe("cancelled");
    expect(harvest).toHaveBeenCalledTimes(1);
    const org = store.snapshot(ORG);
    expect(org.inventories.azure).toBeUndefined();
    expect(org.facts).toEqual([]);
    expect(org.findings).toEqual([]);
    expect(org.issues).toEqual([]);
    expect(org.scans.map((job) => job.status)).toEqual(["cancelled", "cancelled"]);
    expect(store.runningScan(ORG, "sub-a")).toBeUndefined();
  });

  it("removes its abort listener once the harvest settles", async () => {
    const store = new MemoryStore(fixedClock);
    const track = store.trackScan.bind(store);
    let removed: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(store, "trackScan").mockImplementation((orgId) => {
      const tracked = track(orgId);
      removed = vi.spyOn(tracked.signal, "removeEventListener");
      return tracked;
    });
    await scan(new ScanRunner(store, harvesterFor(TWO_SUBSCRIPTIONS), {}, fixedClock), "sub-a");
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("lists each billing scope once when combining commitments", () => {
    const store = new MemoryStore(fixedClock);
    const snapshot = (subscriptionId: string) => ({
      subscriptionId,
      billingScope: "/providers/Microsoft.Billing/billingAccounts/shared",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      reservations: [],
      savingsPlans: [],
      noneFound: { reservations: true, savingsPlans: true },
    });
    store.putCommitments(ORG, snapshot("sub-a"));
    store.putCommitments(ORG, snapshot("sub-b"));
    expect(store.snapshot(ORG).commitments?.billingScope).toBe("/providers/Microsoft.Billing/billingAccounts/shared");
  });
});
