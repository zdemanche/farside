import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  RESERVATIONS_ROLE_CLOSER,
  RESERVATION_USE,
  SAVINGS_PLAN_USE,
  checkReservations,
  checkSavingsPlans,
  emptyCommitmentClient,
  harvestCommitments,
  fixtureCommitmentClient,
  missingReservationsRoleClient,
} from "./commitments.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const PERIOD = { subscriptionId: "main", periodStart: "2026-10-01", periodEnd: "2026-10-31" };

describe("commitment use checks", () => {
  it("fails low reservation use with an unused-spend range and passes a well-used one", () => {
    const findings = checkReservations(
      [
        {
          reservationId: "res-low",
          skuName: "Standard_D2s_v3",
          usedHours: 200,
          reservedHours: 720,
          utilisationPercent: 27.78,
          expiryDate: "2027-01-01",
        },
        {
          reservationId: "res-used",
          skuName: "Standard_B2s",
          usedHours: 700,
          reservedHours: 720,
          utilisationPercent: 97.22,
          expiryDate: "2027-06-01",
        },
      ],
      PERIOD,
    );
    const low = findings.find((finding) => finding.evidence.fields.reservationId === "res-low");
    const used = findings.find((finding) => finding.evidence.fields.reservationId === "res-used");
    expect(low?.result).toBe("fail");
    expect(low?.savings).toEqual({ min: "52.00", max: "78.00", currency: "USD" });
    expect(low?.evidence.fields.periodStart).toBe("2026-10-01");
    expect(used?.result).toBe("pass");
    expect(used?.savings).toBeUndefined();
  });

  it("fails low savings-plan use with a range and says none found instead of zero use", () => {
    const low = checkSavingsPlans(
      [
        {
          savingsPlanId: "sp-low",
          committedAmount: "100.00",
          usedAmount: "30.00",
          utilisationPercent: 30,
          expiryDate: "2027-01-01",
          currency: "USD",
        },
      ],
      PERIOD,
    )[0];
    expect(low?.result).toBe("fail");
    expect(low?.savings).toEqual({ min: "56.00", max: "84.00", currency: "USD" });
    const eur = checkSavingsPlans(
      [
        {
          savingsPlanId: "sp-eur",
          committedAmount: "1000.00",
          usedAmount: "500.00",
          utilisationPercent: 50,
          expiryDate: "2027-01-01",
          currency: "EUR",
        },
      ],
      PERIOD,
    )[0];
    expect(eur?.savings).toEqual({ min: "400.00", max: "600.00", currency: "EUR" });
    const none = checkReservations([], PERIOD)[0];
    expect(none?.result).toBe("pass");
    expect(none?.evidence.fields.noneFound).toBe(true);
    expect(none?.evidence.fields.utilisationPercent).toBeUndefined();
    expect(JSON.stringify(none)).not.toMatch(/"utilisationPercent":0/);
  });
});

describe("commitment harvest", () => {
  it("stores fixture utilization and assesses both checks", async () => {
    const harvested = await harvestCommitments({
      client: fixtureCommitmentClient(),
      subscriptionId: "main",
      billingScope: "/subscriptions/main",
    });
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) {
      return;
    }
    expect(harvested.snapshot.reservations).toHaveLength(2);
    expect(harvested.snapshot.savingsPlans).toHaveLength(2);
    expect(harvested.snapshot.noneFound).toEqual({ reservations: false, savingsPlans: false });
    expect(harvested.findings.some((finding) => finding.result === "fail")).toBe(true);
    expect(harvested.coverage.every((entry) => entry.state === "assessed")).toBe(true);
  });

  it("records none-found when the list is empty", async () => {
    const harvested = await harvestCommitments({
      client: emptyCommitmentClient(),
      subscriptionId: "main",
      billingScope: "/subscriptions/main",
    });
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) {
      return;
    }
    expect(harvested.snapshot.noneFound).toEqual({ reservations: true, savingsPlans: true });
    expect(harvested.findings.every((finding) => finding.evidence.fields.noneFound === true)).toBe(
      true,
    );
  });

  it("leaves commitments unassessed when Reservations Reader is missing", async () => {
    const harvested = await harvestCommitments({
      client: missingReservationsRoleClient(),
      subscriptionId: "main",
      billingScope: "/subscriptions/main",
    });
    expect(harvested.ok).toBe(false);
    if (harvested.ok) {
      return;
    }
    expect(harvested.coverage.find((entry) => entry.checkId === RESERVATION_USE)).toMatchObject({
      state: "unassessed",
      closer: RESERVATIONS_ROLE_CLOSER,
    });
    expect(harvested.coverage.find((entry) => entry.checkId === SAVINGS_PLAN_USE)?.state).toBe(
      "unassessed",
    );
  });
});

describe("commitment routes", () => {
  const store = new MemoryStore(fixedClock);
  store.putConnection("org-a", { tenantId: "tenant-1", subscriptionId: "main" });
  const app = buildApp(store, { ...TEST_APP_OPTIONS, commitmentClient: fixtureCommitmentClient() });

  afterAll(async () => {
    await app.close();
  });

  it("harvests fixture commitments through the API", async () => {
    const posted = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/commitments",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().harvested).toBe(true);
    expect(posted.json().findings.some((finding: { result: string }) => finding.result === "fail")).toBe(
      true,
    );
    const stored = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/commitments",
      headers: ORG,
    });
    expect(stored.json().reservations[0].reservationId).toBe("res-low");
    const issues = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/issues",
      headers: ORG,
    });
    const reservation = (issues.json().issues as Array<{
      checkId: string;
      resourceId: string;
      status: string;
    }>).find((issue) => issue.checkId === RESERVATION_USE && issue.resourceId === "res-low");
    expect(reservation?.status).toBe("open");
  });
});
