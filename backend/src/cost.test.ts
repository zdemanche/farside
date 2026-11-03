import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  CrossCurrencyError,
  MONTH_ON_MONTH,
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
  const store = new MemoryStore();
  const app = buildApp(store);

  afterAll(async () => {
    await app.close();
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
  const store = new MemoryStore();
  const app = buildApp(store, { costClient: missingCostRoleClient() });

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
