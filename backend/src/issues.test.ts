import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import { recordCoverageScope } from "./coverage.js";
import { applyScanToIssues, issueIdentity, resourceIdFromFinding } from "./issues.js";
import { defaultHarvester } from "./scans.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const SCOPE = {
  id: "main:azure-waste-unattached-disks",
  cloud: "azure" as const,
  subscriptionOrProject: "main",
};

function failFinding(resourceId = "disk-unattached"): Finding {
  return {
    checkId: "azure-waste-unattached-disks",
    result: "fail",
    evidence: { fields: { diskId: resourceId, diskState: "Unattached" } },
    scope: SCOPE,
    savings: { min: "8.00", max: "12.00", currency: "USD" },
  };
}

const assessed = [
  recordCoverageScope({
    subscriptionOrProject: "main",
    checkId: "azure-waste-unattached-disks",
    state: "assessed",
  }),
];

const unassessed = [
  recordCoverageScope({
    subscriptionOrProject: "main",
    checkId: "azure-waste-unattached-disks",
    state: "unassessed",
    causeId: "not_run",
  }),
];

describe("issue identity", () => {
  it("keys by check, resource and scope so a repeat scan updates the same issue", () => {
    const first = applyScanToIssues({
      issues: [],
      findings: [failFinding()],
      coverage: assessed,
      scanId: "scan-1",
      observedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe(
      issueIdentity("azure-waste-unattached-disks", "disk-unattached", SCOPE.id),
    );
    expect(resourceIdFromFinding(failFinding())).toBe("disk-unattached");
    const second = applyScanToIssues({
      issues: first,
      findings: [failFinding()],
      coverage: assessed,
      scanId: "scan-2",
      observedAt: "1970-01-02T00:00:00.000Z",
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.firstSeen).toBe("1970-01-01T00:00:00.000Z");
    expect(second[0]?.lastConfirmed).toBe("1970-01-02T00:00:00.000Z");
    expect(second[0]?.status).toBe("open");
  });
});

describe("close only if covered", () => {
  it("closes when a later assessed scan no longer finds the problem", () => {
    const opened = applyScanToIssues({
      issues: [],
      findings: [failFinding()],
      coverage: assessed,
      scanId: "scan-1",
      observedAt: "1970-01-01T00:00:00.000Z",
    });
    const closed = applyScanToIssues({
      issues: opened,
      findings: [],
      coverage: assessed,
      scanId: "scan-2",
      observedAt: "1970-01-02T00:00:00.000Z",
    });
    expect(closed[0]?.status).toBe("closed");
    expect(closed[0]?.closingScanId).toBe("scan-2");
  });

  it("stays open as not confirmed when the later scan did not cover the scope", () => {
    const opened = applyScanToIssues({
      issues: [],
      findings: [failFinding()],
      coverage: assessed,
      scanId: "scan-1",
      observedAt: "1970-01-01T00:00:00.000Z",
    });
    const held = applyScanToIssues({
      issues: opened,
      findings: [],
      coverage: unassessed,
      scanId: "scan-2",
      observedAt: "1970-01-02T00:00:00.000Z",
    });
    expect(held[0]?.status).toBe("not_confirmed");
    expect(held[0]?.notConfirmedReason).toMatch(/not run|could not confirm/i);
    expect(held[0]?.closingScanId).toBeUndefined();
  });
});

describe("undetermined results never close an issue", () => {
  const undeterminedFinding: Finding = {
    checkId: "azure-waste-unattached-disks",
    result: "undetermined",
    closer: "A disk read that includes diskState and managedBy",
    evidence: { fields: { diskId: "disk-unattached" } },
    scope: SCOPE,
  };
  const passFinding: Finding = {
    checkId: "azure-waste-unattached-disks",
    result: "pass",
    evidence: { fields: { diskId: "disk-unattached", diskState: "Attached" } },
    scope: SCOPE,
  };

  function opened() {
    return applyScanToIssues({
      issues: [],
      findings: [failFinding()],
      coverage: assessed,
      scanId: "scan-1",
      observedAt: "1970-01-01T00:00:00.000Z",
    });
  }

  it("holds a failing issue as not confirmed with the closer when the next result is undetermined", () => {
    const held = applyScanToIssues({
      issues: opened(),
      findings: [undeterminedFinding],
      coverage: assessed,
      scanId: "scan-2",
      observedAt: "1970-01-02T00:00:00.000Z",
    });
    expect(held[0]?.status).toBe("not_confirmed");
    expect(held[0]?.notConfirmedReason).toBe(undeterminedFinding.closer);
    expect(held[0]?.closingScanId).toBeUndefined();
  });

  it("still closes the issue on an explicit pass", () => {
    const closed = applyScanToIssues({
      issues: opened(),
      findings: [passFinding],
      coverage: assessed,
      scanId: "scan-2",
      observedAt: "1970-01-02T00:00:00.000Z",
    });
    expect(closed[0]?.status).toBe("closed");
    expect(closed[0]?.closingScanId).toBe("scan-2");
  });
});

describe("replay scans", () => {
  it("replays fixed, unfixed and uncovered scans into the expected states", () => {
    const opened = applyScanToIssues({
      issues: [],
      findings: [failFinding("disk-unattached"), failFinding("disk-other")],
      coverage: assessed,
      scanId: "scan-1",
      observedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(opened).toHaveLength(2);
    const mixed = applyScanToIssues({
      issues: opened,
      findings: [failFinding("disk-unattached")],
      coverage: assessed,
      scanId: "scan-2",
      observedAt: "1970-01-02T00:00:00.000Z",
    });
    expect(mixed.find((issue) => issue.resourceId === "disk-unattached")?.status).toBe("open");
    expect(mixed.find((issue) => issue.resourceId === "disk-other")?.status).toBe("closed");
    const uncovered = applyScanToIssues({
      issues: mixed.filter((issue) => issue.resourceId === "disk-unattached"),
      findings: [],
      coverage: unassessed,
      scanId: "scan-3",
      observedAt: "1970-01-03T00:00:00.000Z",
    });
    expect(uncovered[0]?.status).toBe("not_confirmed");
  });

  it("limits a harvest apply to named check ids so other issues stay open", () => {
    const opened = applyScanToIssues({
      issues: [],
      findings: [failFinding()],
      coverage: assessed,
      scanId: "scan-1",
      observedAt: "1970-01-01T00:00:00.000Z",
    });
    const harvest = applyScanToIssues({
      issues: opened,
      findings: [
        {
          checkId: "azure-cost-subscriptions-without-budgets",
          result: "fail",
          evidence: { fields: { subscriptionId: "empty-no-budget", budgetCount: 0 } },
          scope: {
            id: "empty-no-budget:azure-cost-subscriptions-without-budgets",
            cloud: "azure",
            subscriptionOrProject: "empty-no-budget",
          },
        },
      ],
      coverage: [
        ...assessed,
        recordCoverageScope({
          subscriptionOrProject: "empty-no-budget",
          checkId: "azure-cost-subscriptions-without-budgets",
          state: "assessed",
        }),
      ],
      scanId: "harvest-budgets",
      observedAt: "1970-01-02T00:00:00.000Z",
      checkIds: ["azure-cost-subscriptions-without-budgets"],
    });
    expect(harvest.find((issue) => issue.resourceId === "disk-unattached")?.status).toBe("open");
    expect(
      harvest.find((issue) => issue.checkId === "azure-cost-subscriptions-without-budgets")?.status,
    ).toBe("open");
    expect(harvest.find((issue) => issue.scopeId === "empty-no-budget:azure-cost-subscriptions-without-budgets")).toBeTruthy();
  });
});

describe("scan into issue store", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, { ...TEST_APP_OPTIONS, harvester: defaultHarvester() });
  const headers = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

  afterAll(async () => {
    await app.close();
  });

  it("stores one issue per fail finding and does not duplicate on a second scan", async () => {
    const first = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers,
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });
    expect(first.statusCode).toBe(201);
    let issues: Array<{ id: string; status: string; resourceId: string }> = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({ method: "GET", url: "/v1/orgs/org-a/issues", headers });
      issues = response.json().issues;
      if (issues.some((issue) => issue.resourceId === "disk-unattached")) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const firstCount = issues.length;
    expect(firstCount).toBeGreaterThan(0);
    expect(issues.filter((issue) => issue.resourceId === "disk-unattached")).toHaveLength(1);
    const second = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers,
      payload: { subscriptionId: "main" },
    });
    expect([200, 202]).toContain(second.statusCode);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({ method: "GET", url: "/v1/orgs/org-a/issues", headers });
      issues = response.json().issues;
      if (issues.length >= firstCount) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(issues.filter((issue) => issue.resourceId === "disk-unattached")).toHaveLength(1);
    expect(issues.length).toBe(firstCount);
  });
});
