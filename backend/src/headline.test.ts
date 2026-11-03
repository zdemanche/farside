import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import type { CostSnapshot } from "./cost.js";
import { recordCoverageScope } from "./coverage.js";
import { buildHeadline, runRecordsFromSpec, type RunRecord } from "./headline.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

const SPEND = "azure-cost-spend-by-service";
const WASTE_DISK = "azure-waste-unattached-disks";
const WASTE_SNAP = "azure-waste-old-snapshots";
const BACKUP_VM = "azure-resilience-prod-vms-outside-backup";
const LIFECYCLE = "azure-lifecycle-retiring-skus";

const spendRecord: RunRecord = { checkId: SPEND, liveRunAt: "2026-10-01T00:00:00Z" };
const wasteDiskRecord: RunRecord = { checkId: WASTE_DISK, liveRunAt: "2026-10-01T00:00:00Z" };
const wasteSnapRecord: RunRecord = { checkId: WASTE_SNAP, liveRunAt: "2026-10-01T00:00:00Z" };
const backupRecord: RunRecord = { checkId: BACKUP_VM, liveRunAt: "2026-10-01T00:00:00Z" };
const lifecycleRecord: RunRecord = { checkId: LIFECYCLE, liveRunAt: "2026-10-01T00:00:00Z" };

const cost: CostSnapshot = {
  subscriptionId: "main",
  billingScope: "/subscriptions/main",
  currency: "USD",
  agreementType: "EnterpriseAgreement",
  periodStart: "2026-09-01",
  periodEnd: "2026-10-31",
  asOf: "2026-11-01T00:00:00Z",
  provisionalDate: "2026-11-01",
  services: [],
  months: [
    {
      billingScope: "/subscriptions/main",
      currency: "USD",
      agreementType: "EnterpriseAgreement",
      serviceName: "all",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      costAmount: "50.00",
      provisional: false,
    },
    {
      billingScope: "/subscriptions/main",
      currency: "USD",
      agreementType: "EnterpriseAgreement",
      serviceName: "all",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      costAmount: "62.00",
      provisional: false,
    },
  ],
  monthOnMonth: [],
};

const diskFail: Finding = {
  checkId: WASTE_DISK,
  result: "fail",
  evidence: { fields: { diskId: "disk-unattached", diskState: "Unattached" } },
  scope: { id: "main:azure-waste-unattached-disks", cloud: "azure", subscriptionOrProject: "main" },
  savings: { min: "8.00", max: "12.00", currency: "USD" },
};

const snapFail: Finding = {
  checkId: WASTE_SNAP,
  result: "fail",
  evidence: { fields: { snapshotId: "snapshot-old" } },
  scope: { id: "main:azure-waste-old-snapshots", cloud: "azure", subscriptionOrProject: "main" },
  savings: { min: "50.00", max: "90.00", currency: "USD" },
};

const backupFail: Finding = {
  checkId: BACKUP_VM,
  result: "fail",
  evidence: { fields: { vmId: "vm-prod-no-backup", productionCount: 2, unprotectedCount: 1 } },
  scope: { id: "main:azure-resilience-prod-vms-outside-backup", cloud: "azure", subscriptionOrProject: "main" },
};

const NOW = "2026-11-02T00:00:00.000Z";

function daysFromNow(days: number): string {
  return new Date(Date.parse(NOW) + days * 86_400_000).toISOString().slice(0, 10);
}

const lifecycleFail: Finding = {
  checkId: LIFECYCLE,
  result: "fail",
  evidence: { fields: { vmId: "vm-retiring-sku", retirementDate: daysFromNow(30) } },
  scope: { id: "main:azure-lifecycle-retiring-skus", cloud: "azure", subscriptionOrProject: "main" },
};

const backupPass: Finding = {
  ...backupFail,
  result: "pass",
  evidence: { fields: { vmId: "vm-prod-protected", productionCount: 2 } },
};

const assessed = [
  recordCoverageScope({ subscriptionOrProject: "main", checkId: SPEND, state: "assessed" }),
  recordCoverageScope({ subscriptionOrProject: "main", checkId: WASTE_DISK, state: "assessed" }),
  recordCoverageScope({ subscriptionOrProject: "main", checkId: WASTE_SNAP, state: "assessed" }),
  recordCoverageScope({ subscriptionOrProject: "main", checkId: BACKUP_VM, state: "assessed" }),
  recordCoverageScope({ subscriptionOrProject: "main", checkId: LIFECYCLE, state: "assessed" }),
];

function figureOf(headline: ReturnType<typeof buildHeadline>, id: string) {
  const found = headline.figures.find((figure) => figure.id === id);
  if (!found) {
    throw new Error(`missing figure ${id}`);
  }
  return found;
}

describe("headline figures", () => {
  it("labels every check not supported when the spec has no live run records", () => {
    expect(runRecordsFromSpec()).toEqual([]);
    const headline = buildHeadline({
      cost,
      findings: [diskFail, snapFail, backupFail, lifecycleFail],
      coverage: assessed,
      now: NOW,
    });
    expect(headline.figures).toHaveLength(5);
    for (const figure of headline.figures) {
      expect(figure.status).toBe("not_supported");
      expect(figure.value).toBeNull();
      expect(figure.label.length).toBeGreaterThan(0);
      expect(figure.href.startsWith("#")).toBe(true);
    }
  });

  it("fills monthly cost, waste range, backup N of M, lifecycle and unseen when records exist", () => {
    const headline = buildHeadline({
      cost,
      findings: [diskFail, snapFail, backupFail, backupPass, lifecycleFail],
      coverage: assessed,
      records: [spendRecord, wasteDiskRecord, wasteSnapRecord, backupRecord, lifecycleRecord],
      now: NOW,
    });
    expect(figureOf(headline, "monthlyCost")).toMatchObject({
      status: "ok",
      href: "#cost-and-waste",
      value: { amount: "62.00", currency: "USD" },
    });
    expect(figureOf(headline, "waste")).toMatchObject({
      status: "ok",
      href: "#issues",
      value: { min: "58.00", max: "102.00", currency: "USD" },
    });
    expect(figureOf(headline, "backup")).toMatchObject({
      status: "ok",
      href: "#recovery",
      value: { unprotected: 1, production: 2, undetermined: 0 },
    });
    expect(figureOf(headline, "lifecycle")).toMatchObject({
      status: "ok",
      href: "#lifecycle",
      value: { count: 1 },
    });
    expect(figureOf(headline, "unseen")).toMatchObject({
      status: "ok",
      href: "#blind-spots",
      value: { count: 0 },
    });
  });

  it("says not assessed and shows no number when proven checks have no assessed coverage", () => {
    const headline = buildHeadline({
      cost,
      findings: [diskFail],
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: "main",
          checkId: WASTE_DISK,
          state: "unassessed",
          causeId: "not_run",
        }),
      ],
      records: [wasteDiskRecord],
      now: NOW,
    });
    expect(figureOf(headline, "waste")).toEqual({
      id: "waste",
      label: "Nameable waste",
      href: "#issues",
      status: "not_assessed",
      value: null,
    });
  });

  it("excludes a check from every figure after its live run record is removed", () => {
    const input = {
      cost,
      findings: [diskFail, snapFail, backupFail, lifecycleFail],
      coverage: assessed,
      now: NOW,
    };
    const withBoth = buildHeadline({
      ...input,
      records: [spendRecord, wasteDiskRecord, wasteSnapRecord, backupRecord, lifecycleRecord],
    });
    expect(figureOf(withBoth, "waste").value).toMatchObject({ min: "58.00", max: "102.00" });
    const withoutSnap = buildHeadline({
      ...input,
      records: [spendRecord, wasteDiskRecord, backupRecord, lifecycleRecord],
    });
    expect(figureOf(withoutSnap, "waste")).toMatchObject({
      status: "ok",
      value: { min: "8.00", max: "12.00", currency: "USD" },
    });
    const withoutWaste = buildHeadline({
      ...input,
      records: [spendRecord, backupRecord, lifecycleRecord],
    });
    expect(figureOf(withoutWaste, "waste")).toMatchObject({
      status: "not_supported",
      value: null,
    });
    expect(figureOf(withoutWaste, "monthlyCost").status).toBe("ok");
  });
});

describe("headline route", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, TEST_APP_OPTIONS);

  afterAll(async () => {
    await app.close();
  });

  it("returns the headline with every figure not supported until a live run exists", async () => {
    store.putCost("org-a", cost);
    store.putFindings("org-a", [diskFail]);
    store.putCoverage("org-a", assessed);
    const response = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/headline",
      headers: ORG,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ReturnType<typeof buildHeadline>;
    expect(body.sentence).toContain("Unproven checks are not supported");
    expect(body.figures.every((figure) => figure.status === "not_supported")).toBe(true);
    expect(body.figures.every((figure) => figure.value === null)).toBe(true);
  });
});

describe("headline two clouds", () => {
  const gcpWaste = "gcp-waste-unattached-disks";
  const gcpSpend = "gcp-cost-spend-by-service";
  const gcpLifecycle = "gcp-lifecycle-sql-gke-support";
  const gcpDisk: Finding = {
    checkId: gcpWaste,
    result: "fail",
    evidence: { fields: { diskId: "disk-parked", usersCount: 0 } },
    scope: {
      id: "farside-test:gcp-waste-unattached-disks",
      cloud: "gcp",
      subscriptionOrProject: "farside-test",
    },
    savings: { min: "4.00", max: "6.00", currency: "EUR" },
  };
  const gcpLifecycleFail: Finding = {
    checkId: gcpLifecycle,
    result: "fail",
    evidence: { fields: { resourceKind: "sql", version: "MYSQL_5_6", supportEnd: daysFromNow(10) } },
    scope: {
      id: "farside-test:gcp-lifecycle-sql-gke-support",
      cloud: "gcp",
      subscriptionOrProject: "farside-test",
    },
  };
  const gcpCost: CostSnapshot = {
    ...cost,
    subscriptionId: "farside-test",
    billingScope: "//billing.googleapis.com/projects/farside-test",
    currency: "EUR",
    months: [
      {
        billingScope: "//billing.googleapis.com/projects/farside-test",
        currency: "EUR",
        agreementType: "payg",
        serviceName: "all",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        costAmount: "40.00",
        provisional: false,
      },
    ],
  };

  it("keeps money figures per cloud and does not sum USD with EUR", () => {
    const headline = buildHeadline({
      costs: { azure: cost, gcp: gcpCost },
      now: NOW,
      findings: [diskFail, gcpDisk, lifecycleFail, gcpLifecycleFail],
      coverage: [
        ...assessed,
        recordCoverageScope({
          subscriptionOrProject: "farside-test",
          checkId: gcpSpend,
          state: "assessed",
        }),
        recordCoverageScope({
          subscriptionOrProject: "farside-test",
          checkId: gcpWaste,
          state: "assessed",
        }),
        recordCoverageScope({
          subscriptionOrProject: "farside-test",
          checkId: gcpLifecycle,
          state: "assessed",
        }),
      ],
      records: [
        spendRecord,
        wasteDiskRecord,
        lifecycleRecord,
        { checkId: gcpSpend, liveRunAt: "2026-10-01T00:00:00Z" },
        { checkId: gcpWaste, liveRunAt: "2026-10-01T00:00:00Z" },
        { checkId: gcpLifecycle, liveRunAt: "2026-10-01T00:00:00Z" },
      ],
    });
    expect(headline.clouds.map((entry) => entry.cloud)).toEqual(["azure", "gcp"]);
    const azureFigures = headline.clouds.find((entry) => entry.cloud === "azure")?.figures ?? [];
    const gcpFigures = headline.clouds.find((entry) => entry.cloud === "gcp")?.figures ?? [];
    expect(figureOf({ figures: azureFigures }, "waste")).toMatchObject({
      status: "ok",
      value: { min: "8.00", max: "12.00", currency: "USD" },
    });
    expect(figureOf({ figures: gcpFigures }, "waste")).toMatchObject({
      status: "ok",
      value: { min: "4.00", max: "6.00", currency: "EUR" },
    });
    const orgWaste = figureOf(headline, "waste");
    expect(orgWaste.status).toBe("ok");
    expect(orgWaste.value).toMatchObject({ mixedCurrencies: true });
    expect(orgWaste.value).not.toHaveProperty("min");
    expect(orgWaste.value).not.toHaveProperty("max");
    expect(JSON.stringify(orgWaste.value)).not.toMatch(/"min":"12\.00"|"max":"18\.00"/);
    const orgCost = figureOf(headline, "monthlyCost");
    expect(orgCost.value).toMatchObject({ mixedCurrencies: true });
    expect(orgCost.value).not.toHaveProperty("amount");
    expect(JSON.stringify(orgCost.value)).not.toMatch(/"amount":"102\.00"/);
    expect(figureOf(headline, "lifecycle").value).toEqual({ count: 2 });
  });
});

describe("headline backup and lifecycle math", () => {
  const baseInput = { cost, coverage: assessed, records: [backupRecord, lifecycleRecord], now: NOW };
  const SQL = "azure-resilience-prod-sql-outside-backup";
  const sqlRecord: RunRecord = { checkId: SQL, liveRunAt: "2026-10-01T00:00:00Z" };
  const vm = (id: string, result: Finding["result"]): Finding => ({
    ...backupFail,
    result,
    evidence: { fields: { vmId: id, productionCount: 1 } },
  });
  const sql = (id: string, result: Finding["result"]): Finding => ({
    ...backupFail,
    checkId: SQL,
    result,
    evidence: { fields: { sqlResourceId: id } },
    scope: { id: `main:${SQL}`, cloud: "azure", subscriptionOrProject: "main" },
  });
  const sqlAssessed = recordCoverageScope({ subscriptionOrProject: "main", checkId: SQL, state: "assessed" });

  it("counts distinct production resources across pass and fail findings, not the max productionCount", () => {
    const headline = buildHeadline({
      ...baseInput,
      findings: [vm("vm-1", "pass"), vm("vm-2", "pass"), sql("sql-1", "fail")],
      coverage: [...assessed, sqlAssessed],
      records: [backupRecord, sqlRecord],
    });
    expect(figureOf(headline, "backup").value).toEqual({ unprotected: 1, production: 3, undetermined: 0 });
  });

  it("reports 0 of N when all are protected and exposes undetermined resources", () => {
    const headline = buildHeadline({
      ...baseInput,
      findings: [backupPass, vm("vm-unreadable", "undetermined")],
    });
    expect(figureOf(headline, "backup").value).toEqual({ unprotected: 0, production: 1, undetermined: 1 });
  });

  it("keeps resources of a wholly undetermined scope visible instead of showing 0 of N", () => {
    const vmScope = recordCoverageScope({
      subscriptionOrProject: "main",
      checkId: BACKUP_VM,
      state: "undetermined",
      closer: "Backup Reader on the vaults in scope",
    });
    const headline = buildHeadline({
      ...baseInput,
      findings: [vm("vm-1", "undetermined"), vm("vm-2", "undetermined"), sql("sql-1", "pass"), sql("sql-2", "pass")],
      coverage: [vmScope, sqlAssessed],
      records: [backupRecord, sqlRecord],
    });
    expect(figureOf(headline, "backup").value).toEqual({ unprotected: 0, production: 2, undetermined: 2 });
    const vmOnly = buildHeadline({
      ...baseInput,
      findings: [vm("vm-1", "undetermined")],
      coverage: [vmScope],
    });
    expect(figureOf(vmOnly, "backup")).toMatchObject({ status: "not_assessed", value: null });
  });

  it("does not collapse same-named resources in two subscriptions", () => {
    const other: Finding = {
      ...vm("vm-1", "pass"),
      scope: { id: "other:vm", cloud: "azure", subscriptionOrProject: "other" },
    };
    const otherCoverage = recordCoverageScope({
      subscriptionOrProject: "other",
      checkId: BACKUP_VM,
      state: "assessed",
    });
    const headline = buildHeadline({
      ...baseInput,
      findings: [vm("vm-1", "pass"), other],
      coverage: [...assessed, otherCoverage],
    });
    expect(figureOf(headline, "backup").value).toMatchObject({ production: 2 });
  });

  it.each([
    [89, 1],
    [90, 1],
    [91, 0],
  ])("lifecycle finding %i days out counts %i", (days, expected) => {
    const finding: Finding = {
      ...lifecycleFail,
      evidence: { fields: { vmId: "vm-x", retirementDate: daysFromNow(days) } },
    };
    const headline = buildHeadline({ ...baseInput, findings: [finding] });
    expect(figureOf(headline, "lifecycle").value).toEqual({ count: expected });
  });

  it("applies the window to expirationDate, expireTime and supportEnd and skips undated findings", () => {
    const withFields = (fields: Record<string, string>): Finding => ({
      ...lifecycleFail,
      evidence: { fields },
    });
    const findings = [
      withFields({ certId: "far", expirationDate: daysFromNow(150) }),
      withFields({ vmId: "vm-undated" }),
      withFields({ certId: "soon", expirationDate: daysFromNow(5) }),
      withFields({ certId: "gcp-soon", expireTime: `${daysFromNow(5)}T00:00:00Z` }),
      withFields({ vmId: "vm-y", retirementDate: "2029-01-01" }),
    ];
    const headline = buildHeadline({ ...baseInput, findings });
    expect(figureOf(headline, "lifecycle").value).toEqual({ count: 2 });
  });
});
