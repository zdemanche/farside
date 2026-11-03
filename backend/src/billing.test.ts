import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import {
  CardDataError,
  advanceContract,
  billingView,
  canScan,
  effectiveContract,
  isReadOnly,
  parseContract,
  retainUntil,
  retentionElapsed,
} from "./billing.js";
import { ACTOR_HEADER, OPERATOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore, runRetentionSweep } from "./store.js";

const T0 = "2026-10-01T00:00:00.000Z";
const OPERATOR = { [OPERATOR_HEADER]: "op-token" };

function daysAfter(start: string, days: number): string {
  return new Date(Date.parse(start) + days * 86_400_000).toISOString();
}

function orgHeaders(orgId: string) {
  return { [ORG_HEADER]: orgId, [ACTOR_HEADER]: `actor-${orgId}` };
}

describe("contract ladder", () => {
  const base = parseContract({ plan: "farside-standard", startDate: T0 }, T0);
  const unpaid = parseContract({ plan: "farside-standard", startDate: T0, unpaidAt: T0 }, T0);
  if (!base || !unpaid) {
    throw new Error("expected contract");
  }

  it("stores plan and start and allows scans while active, warning, or grace", () => {
    expect(base.plan).toBe("farside-standard");
    expect(base.startDate).toBe(T0);
    expect(canScan(base, T0)).toBe(true);
    expect(effectiveContract(unpaid, daysAfter(T0, 3)).state).toBe("warning");
    expect(effectiveContract(unpaid, daysAfter(T0, 7)).state).toBe("grace");
    expect(canScan(unpaid, daysAfter(T0, 20))).toBe(true);
    expect(isReadOnly(unpaid, daysAfter(T0, 20))).toBe(false);
  });

  it("derives paused on day 21 and retaining on day 51 from unpaidAt alone", () => {
    const paused = effectiveContract(unpaid, daysAfter(T0, 21));
    expect(paused.state).toBe("paused");
    expect(paused.stateChangedAt).toBe(daysAfter(T0, 21));
    expect(canScan(unpaid, daysAfter(T0, 21))).toBe(false);
    expect(isReadOnly(unpaid, daysAfter(T0, 21))).toBe(true);
    expect(effectiveContract(unpaid, daysAfter(T0, 51)).state).toBe("retaining");
    expect(retainUntil(unpaid)).toBe(daysAfter(T0, 51));
  });

  it("materialises elapsed time on advance without resetting the original timestamps", () => {
    const grace = advanceContract(unpaid, { now: daysAfter(T0, 20) });
    expect(grace.state).toBe("grace");
    expect(grace.unpaidAt).toBe(T0);
    expect(grace.stateChangedAt).toBe(daysAfter(T0, 7));
    const paused = advanceContract(grace, { now: daysAfter(T0, 22) });
    expect(paused.state).toBe("paused");
    expect(paused.stateChangedAt).toBe(daysAfter(T0, 21));
  });

  it("ends a contract and retains for 30 days from the end date", () => {
    const ended = advanceContract(base, { now: daysAfter(T0, 5), event: "ended" });
    expect(ended.state).toBe("ended");
    expect(canScan(ended, daysAfter(T0, 6))).toBe(false);
    expect(retainUntil(ended)).toBe(daysAfter(T0, 35));
  });

  it("returns to active when paid and rejects card numbers", () => {
    const warning = advanceContract(base, { now: T0, event: "failed_payment" });
    expect(warning.state).toBe("warning");
    const paid = advanceContract(warning, { now: daysAfter(T0, 1), event: "paid" });
    expect(paid.state).toBe("active");
    expect(paid.unpaidAt).toBeNull();
    expect(() => parseContract({ plan: "x", startDate: T0, cardNumber: "4111111111111111" }, T0)).toThrow(
      CardDataError,
    );
  });

  it.each([
    { name: "grace", day: 7, before: "warning", at: "grace" },
    { name: "paused", day: 21, before: "grace", at: "paused" },
    { name: "retaining", day: 51, before: "paused", at: "retaining" },
  ])("switches to $at exactly at day $day and not 1ms earlier", ({ day, before, at }) => {
    const boundary = daysAfter(T0, day);
    expect(effectiveContract(unpaid, new Date(Date.parse(boundary) - 1).toISOString()).state).toBe(before);
    expect(effectiveContract(unpaid, boundary).state).toBe(at);
    expect(retentionElapsed(unpaid, new Date(Date.parse(daysAfter(T0, 51)) - 1).toISOString())).toBe(false);
    expect(retentionElapsed(unpaid, daysAfter(T0, 51))).toBe(true);
  });

  it("treats a past endDate as ended and keeps the earliest retention deadline", () => {
    const scheduled = parseContract({ plan: "x", startDate: T0, endDate: daysAfter(T0, 10) }, T0);
    if (!scheduled) {
      throw new Error("expected contract");
    }
    expect(effectiveContract(scheduled, daysAfter(T0, 9)).state).toBe("active");
    expect(effectiveContract(scheduled, daysAfter(T0, 10)).state).toBe("ended");
    expect(canScan(scheduled, daysAfter(T0, 11))).toBe(false);
    const both = { ...scheduled, unpaidAt: T0 };
    expect(retainUntil(both)).toBe(daysAfter(T0, 40));
  });

  it("keeps the original end date when ended is sent again", () => {
    const ended = advanceContract(base, { now: daysAfter(T0, 5), event: "ended" });
    const again = advanceContract(ended, { now: daysAfter(T0, 20), event: "ended" });
    expect(again.endDate).toBe(daysAfter(T0, 5));
    expect(again.stateChangedAt).toBe(daysAfter(T0, 5));
    expect(retainUntil(again)).toBe(daysAfter(T0, 35));
  });

  it("requires ISO-8601 with an offset and stores normalised timestamps", () => {
    expect(parseContract({ plan: "x", startDate: "2026-10-01T00:00:00" }, T0)).toBeNull();
    expect(parseContract({ plan: "x", startDate: "October 1 2026" }, T0)).toBeNull();
    const offset = parseContract({ plan: "x", startDate: "2026-10-01T02:00:00+02:00", unpaidAt: "2026-10-01T02:00+02:00" }, T0);
    expect(offset?.startDate).toBe(T0);
    expect(offset?.unpaidAt).toBe(T0);
  });

  it("ignores a submitted state and rejects unparseable dates", () => {
    const forged = parseContract({ plan: "x", startDate: T0, state: "active", stateChangedAt: "2000-01-01" }, T0);
    expect(forged?.stateChangedAt).toBe(T0);
    const pausedClaim = parseContract({ plan: "x", startDate: T0, state: "paused" }, T0);
    expect(pausedClaim?.state).toBe("active");
    expect(parseContract({ plan: "x", startDate: T0, unpaidAt: "not-a-date" }, T0)).toBeNull();
    expect(billingView(unpaid, daysAfter(T0, 30)).canScan).toBe(false);
  });
});

describe("operator-only contract writes and ladder enforcement", () => {
  let clock = T0;
  const provider = vi.fn(() => {
    throw new Error("provider call");
  });
  const store = new MemoryStore(() => clock);
  const app = buildApp(store, {
    operatorToken: "op-token",
    harvester: { harvest: provider },
    costClient: { query: provider },
    commitmentClient: { list: provider },
    budgetClient: { list: provider },
  });

  afterAll(async () => {
    await app.close();
  });

  async function operatorPut(orgId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/v1/orgs/${orgId}/contract`,
      headers: OPERATOR,
      payload: { plan: "farside-standard", startDate: T0, ...payload },
    });
  }

  async function operatorAdvance(orgId: string, event: string) {
    return app.inject({
      method: "POST",
      url: `/v1/orgs/${orgId}/contract/advance`,
      headers: OPERATOR,
      payload: { event },
    });
  }

  function contractOf(orgId: string) {
    return store.snapshot(orgId).contract;
  }

  it("gives an org session 403 on PUT contract and advance paid, leaving the contract unchanged", async () => {
    clock = daysAfter(T0, 25);
    expect((await operatorPut("org-own", { unpaidAt: T0 })).statusCode).toBe(200);
    const before = contractOf("org-own");

    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-own/contract",
      headers: orgHeaders("org-own"),
      payload: { plan: "farside-standard", startDate: T0, state: "active" },
    });
    const paid = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-own/contract/advance",
      headers: orgHeaders("org-own"),
      payload: { event: "paid", now: T0 },
    });

    expect(put.statusCode).toBe(403);
    expect(paid.statusCode).toBe(403);
    expect(contractOf("org-own")).toEqual(before);
    const scan = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-own/scans",
      headers: orgHeaders("org-own"),
      payload: { subscriptionId: "main" },
    });
    expect(scan.statusCode).toBe(409);
  });

  it("lets the operator token write and advance, and refuses a wrong or absent token", async () => {
    clock = T0;
    const created = await operatorPut("org-op", { state: "paused", stateChangedAt: "2000-01-01" });
    expect(created.statusCode).toBe(200);
    expect(created.json().contract.state).toBe("active");
    expect(created.json().contract.stateChangedAt).toBe(T0);
    const failed = await operatorAdvance("org-op", "failed_payment");
    expect(failed.statusCode).toBe(200);
    expect(failed.json().contract.state).toBe("warning");
    const wrong = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-op/contract",
      headers: { [OPERATOR_HEADER]: "nope" },
      payload: { plan: "x", startDate: T0 },
    });
    expect(wrong.statusCode).toBe(403);
    const sessionOnly = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-op/contract/advance",
      headers: orgHeaders("org-op"),
      payload: { event: "paid" },
    });
    expect(sessionOnly.statusCode).toBe(403);
  });

  it("returns 403 on operator routes when no operator token is configured", async () => {
    const open = buildApp(new MemoryStore());
    const response = await open.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/contract",
      headers: { ...OPERATOR, ...orgHeaders("org-a") },
      payload: { plan: "x", startDate: T0 },
    });
    expect(response.statusCode).toBe(403);
    await open.close();
  });

  it("blocks scans on day 21 and offboards with a retention record by day 51 without intermediate calls", async () => {
    clock = T0;
    await operatorPut("org-ladder", { unpaidAt: T0 });

    clock = daysAfter(T0, 21);
    const view = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-ladder/contract",
      headers: orgHeaders("org-ladder"),
    });
    expect(view.json().contract.state).toBe("paused");
    expect(view.json().canScan).toBe(false);
    const scan = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-ladder/scans",
      headers: orgHeaders("org-ladder"),
      payload: { subscriptionId: "main" },
    });
    expect(scan.statusCode).toBe(409);

    clock = daysAfter(T0, 51);
    const tick = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-ladder/schedule/tick",
      headers: orgHeaders("org-ladder"),
      payload: { now: clock },
    });
    expect(tick.statusCode).toBe(410);
    const record = await store.deletion("org-ladder");
    expect(record).toMatchObject({ orgId: "org-ladder", deletedAt: clock, trigger: "retention" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not offboard before the retention window ends", async () => {
    clock = T0;
    await operatorPut("org-early", { unpaidAt: T0 });
    clock = daysAfter(T0, 50);
    expect(await store.sweepRetention(clock)).toEqual([]);
    expect(await store.deletion("org-early")).toBeNull();
  });

  it("offboards an ended contract after 30 days with a retention record", async () => {
    clock = T0;
    await operatorPut("org-ended", {});
    await operatorAdvance("org-ended", "ended");
    clock = daysAfter(T0, 29);
    expect(await store.sweepRetention(clock)).toEqual([]);
    clock = daysAfter(T0, 30);
    expect((await store.sweepRetention(clock)).map((record) => record.trigger)).toEqual(["retention"]);
    expect((await store.deletion("org-ended"))?.orgId).toBe("org-ended");
  });

  const MUTATING = [
    { method: "PUT" as const, url: "/connections", payload: { tenantId: "t", subscriptionId: "s" } },
    { method: "PUT" as const, url: "/inventory", payload: { cloud: "azure", observedAt: T0, resources: [] } },
    {
      method: "PUT" as const,
      url: "/coverage",
      payload: { checkId: "c", subscriptionOrProject: "s", state: "assessed" },
    },
    {
      method: "PUT" as const,
      url: "/settings",
      payload: { ownerTagKey: "owner", productionTagKey: "env", productionTagValue: "prod" },
    },
    { method: "POST" as const, url: "/scans", payload: { subscriptionId: "main" } },
    { method: "POST" as const, url: "/cost", payload: { subscriptionId: "main" } },
    { method: "POST" as const, url: "/commitments", payload: { subscriptionId: "main" } },
    { method: "POST" as const, url: "/budgets", payload: {} },
    { method: "POST" as const, url: "/alerts", payload: {} },
    { method: "DELETE" as const, url: "/connections/conn-1", payload: undefined },
  ];

  const READ_ONLY_DAYS = [{ state: "paused", day: 25 }];

  it.each(READ_ONLY_DAYS)(
    "returns 409 on every mutating route while $state, with no provider call, and still serves GET and export",
    async ({ day }) => {
      const orgId = `org-ro-${day}`;
      clock = T0;
      await operatorPut(orgId, { unpaidAt: T0 });
      clock = daysAfter(T0, day);

      for (const route of MUTATING) {
        const response = await app.inject({
          method: route.method,
          url: `/v1/orgs/${orgId}${route.url}`,
          headers: orgHeaders(orgId),
          ...(route.payload ? { payload: route.payload } : {}),
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(409);
        expect(response.json().error).toBe("console_read_only");
      }
      expect(provider).not.toHaveBeenCalled();

      for (const url of ["/settings", "/contract", "/export/cost", "/export/issues", "/export/inventory"]) {
        const response = await app.inject({
          method: "GET",
          url: `/v1/orgs/${orgId}${url}`,
          headers: orgHeaders(orgId),
        });
        expect(response.statusCode, url).toBe(200);
      }
    },
  );

  it("offboards on the next request once day 51 passes, even if nobody ticks", async () => {
    clock = T0;
    await operatorPut("org-lazy", { unpaidAt: T0 });
    await operatorPut("org-bystander", { unpaidAt: T0 });
    clock = daysAfter(T0, 55);
    const exported = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-lazy/export/cost",
      headers: orgHeaders("org-lazy"),
    });
    expect(exported.statusCode).toBe(410);
    expect(await store.deletion("org-lazy")).toMatchObject({ trigger: "retention", deletedAt: clock });
    const mutate = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-lazy/settings",
      headers: orgHeaders("org-lazy"),
      payload: { ownerTagKey: "owner", productionTagKey: "env", productionTagValue: "prod" },
    });
    expect(mutate.statusCode).toBe(410);
    const tick = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-lazy/schedule/tick",
      headers: orgHeaders("org-lazy"),
      payload: {},
    });
    expect(tick.statusCode).toBe(410);
    expect(await store.deletion("org-bystander")).toBeNull();
    expect((await runRetentionSweep(store, () => clock)).map((record) => record.orgId)).toContain("org-bystander");
    expect((await store.deletion("org-bystander"))?.trigger).toBe("retention");
  });

  it("refuses operator contract writes on the demo org and never sweeps it", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/demo/contract",
      headers: OPERATOR,
      payload: { plan: "x", startDate: T0, unpaidAt: T0 },
    });
    expect(put.statusCode).toBe(403);
    const advance = await app.inject({
      method: "POST",
      url: "/v1/orgs/demo/contract/advance",
      headers: OPERATOR,
      payload: { event: "ended" },
    });
    expect(advance.statusCode).toBe(403);
    const demoStore = new MemoryStore();
    await demoStore.putContract("demo", parseContract({ plan: "x", startDate: T0, unpaidAt: T0 }, T0));
    expect(await demoStore.sweepRetention(daysAfter(T0, 400))).toEqual([]);
    expect(await demoStore.deletion("demo")).toBeNull();
  });

  it("rejects a contract body that includes a card number", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-card/contract",
      headers: OPERATOR,
      payload: { plan: "farside-standard", startDate: T0, cardNumber: "4111111111111111" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().title).toBe("Card data rejected");
  });

  it("returns 409 on mutating routes after the contract ends, and still allows offboard", async () => {
    clock = T0;
    await operatorPut("org-ended-ro", {});
    await operatorAdvance("org-ended-ro", "ended");
    const settings = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-ended-ro/settings",
      headers: orgHeaders("org-ended-ro"),
      payload: { ownerTagKey: "owner", productionTagKey: "env", productionTagValue: "prod" },
    });
    expect(settings.statusCode).toBe(409);
    const offboard = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-ended-ro/offboard",
      headers: orgHeaders("org-ended-ro"),
      payload: { confirm: true, exportOffered: true, now: T0 },
    });
    expect(offboard.statusCode).toBe(200);
    expect(offboard.json().trigger).toBe("customer");
  });

  it.each([3, 10])("keeps the console writable on day %i of the unpaid ladder", async (day) => {
    const orgId = `org-rw-${day}`;
    clock = T0;
    await operatorPut(orgId, { unpaidAt: T0 });
    clock = daysAfter(T0, day);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/orgs/${orgId}/settings`,
      headers: orgHeaders(orgId),
      payload: { ownerTagKey: "owner", productionTagKey: "env", productionTagValue: "prod" },
    });
    expect(response.statusCode).toBe(200);
  });
});
