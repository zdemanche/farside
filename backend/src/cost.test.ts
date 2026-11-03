import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  CURRENCY_CLOSER,
  CrossCurrencyError,
  MONTH_ON_MONTH,
  TWO_MONTHS_CLOSER,
  type CostQueryRow,
  SPEND_BY_SERVICE,
  addAmounts,
  fixtureCostClient,
  harvestCost,
  missingCostRoleClient,
  monthOnMonth,
  readAllCostPages,
  totalSameCurrency,
  type CostFigure,
} from "./cost.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const SCOPE = "/subscriptions/main";

function figure(input: Partial<CostFigure> & Pick<CostFigure, "serviceName" | "periodStart" | "costAmount">): CostFigure {
  return {
    billingScope: SCOPE,
    currency: "USD",
    agreementType: "payg",
    periodEnd: input.periodStart,
    provisional: false,
    ...input,
  };
}

describe("cost paging and currency", () => {
  it("reads every Cost Management page and totals the rows", async () => {
    const rows = await readAllCostPages(fixtureCostClient(), SCOPE);
    expect(rows).toHaveLength(10);
    expect(addAmounts(rows.map((row) => row.costAmount))).toBe("116.00");
  });

  it("refuses to sum figures in different currencies", () => {
    expect(() =>
      totalSameCurrency(
        [
          { costAmount: "10.00", currency: "USD" },
          { costAmount: "8.00", currency: "EUR" },
        ],
        "USD",
      ),
    ).toThrow(CrossCurrencyError);
  });

  it("derives month-on-month change per service from two complete months", () => {
    const changes = monthOnMonth(
      [
        figure({ serviceName: "Virtual Machines", periodStart: "2026-09-01", costAmount: "40.00" }),
        figure({ serviceName: "Storage", periodStart: "2026-09-01", costAmount: "10.00" }),
        figure({ serviceName: "Virtual Machines", periodStart: "2026-10-01", costAmount: "50.00" }),
        figure({ serviceName: "Storage", periodStart: "2026-10-01", costAmount: "12.00" }),
      ],
      "payg",
    );
    expect(changes).toEqual([
      {
        billingScope: SCOPE,
        currency: "USD",
        agreementType: "payg",
        serviceName: "Storage",
        currentMonth: "2026-10",
        previousMonth: "2026-09",
        currentMonthCost: "12.00",
        previousMonthCost: "10.00",
        deltaAmount: "2.00",
        deltaPercent: "20.00",
      },
      {
        billingScope: SCOPE,
        currency: "USD",
        agreementType: "payg",
        serviceName: "Virtual Machines",
        currentMonth: "2026-10",
        previousMonth: "2026-09",
        currentMonthCost: "50.00",
        previousMonthCost: "40.00",
        deltaAmount: "10.00",
        deltaPercent: "25.00",
      },
    ]);
  });
});

describe("cost harvest", () => {
  it("stores aggregates with billing scope and currency and labels the latest day provisional", async () => {
    const harvested = await harvestCost({
      client: fixtureCostClient(),
      subscriptionId: "main",
      billingScope: SCOPE,
      agreementType: "payg",
    });
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) {
      return;
    }
    expect(harvested.snapshot.provisionalDate).toBe("2026-11-02");
    expect(harvested.snapshot.currency).toBe("USD");
    expect(harvested.snapshot.billingScope).toBe(SCOPE);
    expect(harvested.snapshot.agreementType).toBe("payg");
    expect(harvested.snapshot.services.map((row) => row.serviceName)).toEqual([
      "Storage",
      "Virtual Machines",
    ]);
    expect(harvested.snapshot.services.every((row) => row.currency === "USD")).toBe(true);
    expect(harvested.snapshot.months.map((row) => [row.periodStart, row.costAmount])).toEqual([
      ["2026-09-01", "50.00"],
      ["2026-10-01", "62.00"],
    ]);
    expect(harvested.snapshot.monthOnMonth).toHaveLength(2);
    expect(JSON.stringify(harvested.snapshot)).not.toMatch(/armBody|sdkResponse|providerPayload/);
    expect(harvested.coverage.find((entry) => entry.checkId === SPEND_BY_SERVICE)?.state).toBe(
      "assessed",
    );
    expect(harvested.coverage.find((entry) => entry.checkId === MONTH_ON_MONTH)?.state).toBe(
      "assessed",
    );
  });

  function dailyRows(from: string, to: string, currency = "USD"): CostQueryRow[] {
    const rows: CostQueryRow[] = [];
    for (let day = Date.parse(from); day <= Date.parse(to); day += 86_400_000) {
      const date = new Date(day).toISOString().slice(0, 10);
      rows.push({ date, serviceName: "Virtual Machines", costAmount: "1.00", currency });
    }
    return rows;
  }

  const harvestRows = (rows: CostQueryRow[]) =>
    harvestCost({
      client: { query: async () => ({ rows }) },
      subscriptionId: "main",
      billingScope: SCOPE,
      agreementType: "payg",
    });

  it("treats a month starting on the 2nd as partial and leaves month-on-month undetermined", async () => {
    const harvested = await harvestRows(dailyRows("2026-08-20", "2026-10-05"));
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) {
      return;
    }
    expect(harvested.snapshot.monthOnMonth).toEqual([]);
    expect(harvested.snapshot.months.map((row) => row.periodStart)).toEqual(["2026-09-01"]);
    const mom = harvested.coverage.find((entry) => entry.checkId === MONTH_ON_MONTH);
    expect(mom).toMatchObject({ state: "undetermined", closer: TWO_MONTHS_CLOSER });
  });

  it("counts a leading month starting on the 1st as complete", async () => {
    const first = await harvestRows(dailyRows("2026-08-01", "2026-10-05"));
    expect(first.ok && first.snapshot.monthOnMonth.map((row) => row.previousMonth)).toEqual(["2026-08"]);
    const second = await harvestRows(dailyRows("2026-08-02", "2026-10-05"));
    expect(second.ok && second.snapshot.monthOnMonth).toEqual([]);
  });

  it("returns an undetermined currency row instead of throwing on mixed currencies", async () => {
    const rows = [...dailyRows("2026-08-01", "2026-10-05"), ...dailyRows("2026-09-10", "2026-09-10", "EUR")];
    const harvested = await harvestRows(rows);
    expect(harvested.ok).toBe(false);
    if (harvested.ok) {
      return;
    }
    expect(harvested.reason).toBe("mixed_currency");
    expect(harvested.coverage.map((entry) => [entry.state, entry.closer])).toEqual([
      ["undetermined", CURRENCY_CLOSER],
      ["undetermined", CURRENCY_CLOSER],
    ]);
  });

  it("leaves cost unassessed when Cost Management Reader is missing", async () => {
    const harvested = await harvestCost({
      client: missingCostRoleClient(),
      subscriptionId: "main",
      billingScope: SCOPE,
      agreementType: "payg",
    });
    expect(harvested.ok).toBe(false);
    if (harvested.ok) {
      return;
    }
    expect(harvested.reason).toBe("missing_role");
    expect(harvested.coverage.every((entry) => entry.state === "unassessed")).toBe(true);
    expect(harvested.coverage.every((entry) => entry.closer?.includes("Cost Management Reader"))).toBe(
      true,
    );
  });
});

describe("cost routes", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, { ...TEST_APP_OPTIONS, costClient: fixtureCostClient() });

  beforeAll(async () => {
    await store.putConnection("org-a", { tenantId: "tenant-1", subscriptionId: "main" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a harvest for a subscription the org has not connected", async () => {
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
      payload: { subscriptionId: "not-connected" },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("harvests through the API and keeps aggregates only", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
    });
    expect(missing.statusCode).toBe(404);
    const posted = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().harvested).toBe(true);
    expect(posted.json().cost.months).toHaveLength(2);
    const stored = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().billingScope).toBe(SCOPE);
    expect(stored.json().currency).toBe("USD");
  });
});

describe("missing cost role on the API", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, { ...TEST_APP_OPTIONS, costClient: missingCostRoleClient() });

  beforeAll(async () => {
    await store.putConnection("org-a", { tenantId: "tenant-1", subscriptionId: "main" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("records Blind spots copy for Cost Management Reader", async () => {
    const posted = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(posted.json()).toMatchObject({ harvested: false, reason: "missing_role" });
    expect(store.snapshot("org-a").cost).toBeNull();
    const spots = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/blind-spots",
      headers: ORG,
    });
    const spend = spots.json().spots.find((spot: { checkId: string }) => spot.checkId === SPEND_BY_SERVICE);
    expect(spend.closer).toMatch(/Cost Management Reader/);
  });
});

describe("billing scope is built server-side", () => {
  const foreign = "/providers/Microsoft.Billing/billingAccounts/x";

  it("ignores a body billingScope on POST /cost and queries the connected subscription", async () => {
    const store = new MemoryStore(fixedClock);
    await store.putConnection("org-a", { tenantId: "tenant-1", subscriptionId: "Main" });
    const seen: string[] = [];
    const costClient = {
      query: async (input: { billingScope: string }) => {
        seen.push(input.billingScope);
        return { rows: [] };
      },
    };
    const app = buildApp(store, { ...TEST_APP_OPTIONS, costClient });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
      payload: { subscriptionId: "main", billingScope: foreign },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((scope) => scope === "/subscriptions/Main")).toBe(true);
    await app.close();
  });

  it("ignores a body billingScope on POST /commitments", async () => {
    const store = new MemoryStore(fixedClock);
    await store.putConnection("org-a", { tenantId: "tenant-1", subscriptionId: "main" });
    const seen: string[] = [];
    const commitmentClient = {
      list: async (input: { billingScope: string }) => {
        seen.push(input.billingScope);
        return { periodStart: "2026-01-01", periodEnd: "2026-01-31", reservations: [], savingsPlans: [] };
      },
    };
    const app = buildApp(store, { ...TEST_APP_OPTIONS, commitmentClient });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/commitments",
      headers: ORG,
      payload: { subscriptionId: "main", billingScope: foreign },
    });
    expect(seen).toEqual(["/subscriptions/main"]);
    await app.close();
  });
});
