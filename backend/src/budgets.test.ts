import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  BUDGET_CLOSER,
  NO_BUDGETS,
  budgetsFromManifest,
  checkNoBudgets,
  harvestBudgets,
  unreadBudgetClient,
} from "./budgets.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";

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
  const store = new MemoryStore();
  const app = buildApp(store);

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
  });
});
