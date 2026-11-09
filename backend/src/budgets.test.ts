import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  BUDGET_CLOSER,
  NO_BUDGETS,
  budgetsFromManifest,
  checkNoBudgets,
  fixtureBudgetClient,
  harvestBudgets,
  mergeBudgetFindings,
  mergeBudgetSnapshot,
  unreadBudgetClient,
} from "./budgets.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const CONFIRMED = "1970-01-01T00:00:00.000Z";

describe("no-budget check", () => {
  it("flags the empty subscription and passes the one with a budget", () => {
    const findings = checkNoBudgets(budgetsFromManifest(), CONFIRMED);
    const empty = findings.find((finding) => finding.scope.subscriptionOrProject === "empty-no-budget");
    const main = findings.find((finding) => finding.scope.subscriptionOrProject === "main");
    expect(empty?.result).toBe("fail");
    expect(empty?.evidence.fields).toMatchObject({
      subscriptionId: "empty-no-budget",
      budgetCount: 0,
      budgetNames: "",
      lastConfirmed: CONFIRMED,
    });
    expect(main?.result).toBe("pass");
    expect(main?.evidence.fields.budgetNames).toBe("farside-test-guard");
    expect(main?.evidence.fields.lastConfirmed).toBe(CONFIRMED);
  });

  it("stores fixture definitions as aggregates and marks the harvest unverified", async () => {
    const harvested = await harvestBudgets({ client: fixtureBudgetClient() });
    expect(harvested.snapshot.subscriptions).toHaveLength(2);
    expect(harvested.snapshot.subscriptions.map((row) => row.subscriptionId).sort()).toEqual([
      "empty-no-budget",
      "main",
    ]);
    expect(harvested.snapshot.harvestStatus).toBe("unverified");
    expect(harvested.snapshot.liveRunAt).toBeNull();
    expect(harvested.snapshot.harvestStatusReason).toMatch(/ground-truth fixture/);
  });

  it("returns undetermined when budgets cannot be read", async () => {
    const harvested = await harvestBudgets({ client: unreadBudgetClient("empty-no-budget") });
    const unread = harvested.findings.find(
      (finding) => finding.scope.subscriptionOrProject === "empty-no-budget",
    );
    expect(unread?.result).toBe("undetermined");
    expect(unread?.closer).toBe(BUDGET_CLOSER);
    expect(unread?.evidence.fields.lastConfirmed).toBe(CONFIRMED);
    expect(harvested.coverage.find((entry) => entry.subscriptionOrProject === "empty-no-budget")).toMatchObject(
      {
        checkId: NO_BUDGETS,
        state: "undetermined",
        closer: BUDGET_CLOSER,
      },
    );
    expect(
      harvested.findings.find((finding) => finding.scope.subscriptionOrProject === "main")?.result,
    ).toBe("pass");
  });
});

describe("budget routes", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, { ...TEST_APP_OPTIONS, budgetClient: fixtureBudgetClient() });

  afterAll(async () => {
    await app.close();
  });

  it("harvests seeded budget definitions through the API", async () => {
    const posted = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/budgets",
      headers: ORG,
    });
    expect(posted.statusCode).toBe(200);
    const fail = posted.json().findings.find(
      (finding: { scope: { subscriptionOrProject: string } }) =>
        finding.scope.subscriptionOrProject === "empty-no-budget",
    );
    expect(fail.result).toBe("fail");
    const stored = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/budgets",
      headers: ORG,
    });
    expect(stored.json().subscriptions).toHaveLength(2);
    const issues = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/issues",
      headers: ORG,
    });
    const budgetIssues = (issues.json().issues as Array<{
      checkId: string;
      subscriptionOrProject: string;
      status: string;
      scopeId: string;
    }>).filter((issue) => issue.checkId === NO_BUDGETS);
    expect(budgetIssues).toHaveLength(1);
    expect(budgetIssues[0]).toMatchObject({
      subscriptionOrProject: "empty-no-budget",
      status: "open",
      scopeId: "empty-no-budget:azure-cost-subscriptions-without-budgets",
    });
  });
});

describe("budget merge for one-subscription scans", () => {
  const row = (subscriptionId: string, budgetCount: number) => ({
    subscriptionId,
    budgetCount,
    budgetNames: budgetCount ? ["guard"] : [],
    readable: true,
  });

  it("replaces only the scanned subscription's finding and snapshot row", () => {
    const first = checkNoBudgets([row("a", 1), row("b", 0)], "2026-11-01T00:00:00.000Z");
    const next = checkNoBudgets([row("b", 1)], "2026-11-02T00:00:00.000Z");
    const merged = mergeBudgetFindings(first, next, ["b"]);
    expect(merged.map((finding) => [finding.scope.subscriptionOrProject, finding.result])).toEqual([
      ["a", "pass"],
      ["b", "pass"],
    ]);
    expect(mergeBudgetFindings(first, next).map((finding) => finding.scope.subscriptionOrProject)).toEqual(["b"]);
    const snapshot = mergeBudgetSnapshot(
      { lastConfirmed: "x", subscriptions: [row("a", 1), row("b", 0)] },
      { lastConfirmed: "y", subscriptions: [row("b", 1)] },
    );
    expect(snapshot.subscriptions.map((item) => [item.subscriptionId, item.budgetCount])).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });
});
