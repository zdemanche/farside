import { assertValid, validateFinding, validateInventory, type Finding, type Inventory } from "@farside/scan-contracts";
import type { AlertAnalysis } from "./alerts.js";
import type { BudgetSnapshot } from "./budgets.js";
import type { CommitmentSnapshot } from "./commitments.js";
import type { CostSnapshot } from "./cost.js";
import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { applyScanToIssues, type StoredIssue } from "./issues.js";
import { diskMonthlySavings } from "./savings.js";
import type { Harvester, ScanJob } from "./scans.js";
import type { MemoryStore } from "./store.js";

export const DEMO_ORG_ID = "demo";
export const DEMO_LABEL = "Demo";
export const DEMO_SUBSCRIPTION = "lumen-east";
export const DEMO_TENANT = "tenant-lumen";
export const DEMO_OBSERVED_AT = "2026-10-15T12:00:00.000Z";

const FORBIDDEN = /moonaan|dashmeta|atlas|\baif\b|zdemanche/i;

export class ProviderCallBlockedError extends Error {
  constructor() {
    super("demo mode blocks provider calls");
    this.name = "ProviderCallBlockedError";
  }
}

export function guardProviderClient<T extends object>(orgId: string, client: T): T {
  if (!isDemoOrg(orgId)) {
    return client;
  }
  return new Proxy(client, {
    get: () => () => {
      throw new ProviderCallBlockedError();
    },
  });
}

export function guardHarvester(harvester: Harvester): Harvester {
  return {
    harvest: (input) => guardProviderClient(input.orgId, harvester).harvest(input),
  };
}

export function isDemoOrg(orgId: string): boolean {
  return orgId === DEMO_ORG_ID;
}

export function demoDescriptor(orgId: string): { orgId: string; demo: boolean; label: string | null } {
  const demo = isDemoOrg(orgId);
  return { orgId, demo, label: demo ? DEMO_LABEL : null };
}

export function assertSynthetic(value: unknown): void {
  const text = JSON.stringify(value);
  const match = FORBIDDEN.exec(text);
  if (match) {
    throw new Error(`demo data must not include ${match[0]}`);
  }
}

function resource(
  type: string,
  id: string,
  displayName: string,
  tags: Record<string, string>,
): Inventory["resources"][number] {
  const owner = tags.owner;
  return {
    resourceUri: `/subscriptions/${DEMO_SUBSCRIPTION}/resourceGroups/harbor/providers/${type}/${id}`,
    resourceType: type,
    region: "eastus",
    displayName,
    tags,
    ownerTag: owner && owner.length > 0 ? owner : null,
  };
}

function finding(input: {
  checkId: string;
  result: Finding["result"];
  fields: Finding["evidence"]["fields"];
  savings?: Finding["savings"];
}): Finding {
  const created: Finding = {
    checkId: input.checkId,
    result: input.result,
    evidence: { fields: input.fields },
    scope: {
      id: `${DEMO_SUBSCRIPTION}:${input.checkId}`,
      cloud: "azure",
      subscriptionOrProject: DEMO_SUBSCRIPTION,
    },
  };
  if (input.savings) {
    created.savings = input.savings;
  }
  return created;
}

function monthFigure(periodStart: string, periodEnd: string, costAmount: string) {
  return {
    billingScope: `/subscriptions/${DEMO_SUBSCRIPTION}`,
    currency: "USD",
    agreementType: "payg",
    serviceName: "all",
    periodStart,
    periodEnd,
    costAmount,
    provisional: false,
  };
}

export function generateDemoEstate(): {
  inventory: Inventory;
  findings: Finding[];
  coverage: CoverageEntry[];
  cost: CostSnapshot;
  commitments: CommitmentSnapshot;
  budgets: BudgetSnapshot;
  alerts: AlertAnalysis;
  issues: StoredIssue[];
  scan: Omit<ScanJob, "id">;
} {
  const diskSavings = diskMonthlySavings(128);
  const inventory: Inventory = {
    cloud: "azure",
    observedAt: DEMO_OBSERVED_AT,
    resources: [
      resource("Microsoft.Compute/disks", "disk-parked", "Parked managed disk", {}),
      resource("Microsoft.Compute/virtualMachines", "vm-harbor", "Harbor production VM", {
        owner: "lumen-ops",
        environment: "prod",
      }),
      resource("Microsoft.Compute/snapshots", "snap-stale", "Stale disk snapshot", {
        owner: "lumen-ops",
      }),
    ],
  };
  const findings: Finding[] = [
    finding({
      checkId: "azure-waste-unattached-disks",
      result: "fail",
      fields: { diskId: "disk-parked", diskState: "Unattached", sizeGb: 128 },
      savings: { min: diskSavings.min, max: diskSavings.max, currency: diskSavings.currency },
    }),
    finding({
      checkId: "azure-resilience-prod-vms-outside-backup",
      result: "fail",
      fields: { vmId: "vm-harbor", productionCount: 1, unprotectedCount: 1, protected: false },
    }),
    finding({
      checkId: "azure-lifecycle-retiring-skus",
      result: "fail",
      fields: { vmId: "vm-harbor", sku: "Standard_D2_v2", retirementDate: "2026-12-01" },
    }),
  ];
  const coverage = [
    recordCoverageScope({
      subscriptionOrProject: DEMO_SUBSCRIPTION,
      checkId: "azure-inventory-all-resources",
      state: "assessed",
    }),
    recordCoverageScope({
      subscriptionOrProject: DEMO_SUBSCRIPTION,
      checkId: "azure-waste-unattached-disks",
      state: "assessed",
    }),
    recordCoverageScope({
      subscriptionOrProject: DEMO_SUBSCRIPTION,
      checkId: "azure-resilience-prod-vms-outside-backup",
      state: "assessed",
    }),
    recordCoverageScope({
      subscriptionOrProject: DEMO_SUBSCRIPTION,
      checkId: "azure-lifecycle-retiring-skus",
      state: "assessed",
    }),
    recordCoverageScope({
      subscriptionOrProject: DEMO_SUBSCRIPTION,
      checkId: "azure-cost-spend-by-service",
      state: "assessed",
    }),
  ];
  assertValid(validateInventory(inventory));
  for (const item of findings) {
    assertValid(validateFinding(item));
  }
  const issues = applyScanToIssues({
    issues: [],
    findings,
    coverage,
    scanId: "scan-1",
    observedAt: DEMO_OBSERVED_AT,
  });
  const cost: CostSnapshot = {
    subscriptionId: DEMO_SUBSCRIPTION,
    billingScope: `/subscriptions/${DEMO_SUBSCRIPTION}`,
    currency: "USD",
    agreementType: "payg",
    periodStart: "2026-08-01",
    periodEnd: "2026-09-30",
    asOf: DEMO_OBSERVED_AT,
    provisionalDate: null,
    services: [
      {
        ...monthFigure("2026-09-01", "2026-09-30", "84.00"),
        serviceName: "Virtual Machines",
      },
    ],
    months: [monthFigure("2026-08-01", "2026-08-31", "70.00"), monthFigure("2026-09-01", "2026-09-30", "84.00")],
    monthOnMonth: [
      {
        billingScope: `/subscriptions/${DEMO_SUBSCRIPTION}`,
        currency: "USD",
        agreementType: "payg",
        serviceName: "Virtual Machines",
        currentMonth: "2026-09",
        previousMonth: "2026-08",
        currentMonthCost: "84.00",
        previousMonthCost: "70.00",
        deltaAmount: "14.00",
        deltaPercent: "20.00",
      },
    ],
  };
  const commitments: CommitmentSnapshot = {
    subscriptionId: DEMO_SUBSCRIPTION,
    billingScope: `/subscriptions/${DEMO_SUBSCRIPTION}`,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    reservations: [
      {
        reservationId: "res-harbor",
        skuName: "Standard_D2s_v3",
        usedHours: 40,
        reservedHours: 100,
        utilisationPercent: 40,
        expiryDate: "2027-03-01",
      },
    ],
    savingsPlans: [],
    noneFound: { reservations: false, savingsPlans: true },
  };
  const budgets: BudgetSnapshot = {
    lastConfirmed: DEMO_OBSERVED_AT,
    subscriptions: [
      {
        subscriptionId: DEMO_SUBSCRIPTION,
        budgetCount: 1,
        budgetNames: ["lumen-guard"],
        readable: true,
      },
    ],
  };
  const alerts: AlertAnalysis = {
    asOf: "2026-10-15",
    historyDays: 14,
    floorBurst: [
      {
        date: "2026-10-15",
        actual: "12.00",
        floor: "8.00",
        burst: "4.00",
        currency: "USD",
      },
    ],
    alerts: [],
    digest: {
      date: "2026-10-15",
      recipients: [],
      alerts: [],
      withheldRepeats: 0,
      delivered: false,
      reason: "no_recipients",
    },
    undetermined: null,
  };
  const scan: Omit<ScanJob, "id"> = {
    orgId: DEMO_ORG_ID,
    subscriptionId: DEMO_SUBSCRIPTION,
    cloud: "azure",
    actor: "system",
    status: "succeeded",
    complete: true,
    coveredScopes: coverage.filter((entry) => entry.state === "assessed").map((entry) => entry.id),
    createdAt: DEMO_OBSERVED_AT,
    startedAt: DEMO_OBSERVED_AT,
    finishedAt: DEMO_OBSERVED_AT,
    error: null,
    durationMs: 1800,
    coverageSummary: { assessed: coverage.length, unassessed: 0, undetermined: 0 },
    checks: coverage.map((entry) => ({ checkId: entry.checkId, state: entry.state })),
  };
  const estate = { inventory, findings, coverage, cost, commitments, budgets, alerts, issues, scan };
  assertSynthetic(estate);
  return estate;
}

export function seedDemoOrg(store: MemoryStore): void {
  if (store.org(DEMO_ORG_ID).inventory) {
    return;
  }
  const estate = generateDemoEstate();
  store.putInventory(DEMO_ORG_ID, estate.inventory);
  store.putCoverage(DEMO_ORG_ID, estate.coverage);
  store.putFindings(DEMO_ORG_ID, estate.findings);
  store.putIssues(DEMO_ORG_ID, estate.issues);
  store.putCost(DEMO_ORG_ID, estate.cost);
  store.putCommitments(DEMO_ORG_ID, estate.commitments);
  store.putBudgets(DEMO_ORG_ID, estate.budgets);
  store.putAlerts(DEMO_ORG_ID, estate.alerts);
  store.putConnection(DEMO_ORG_ID, { tenantId: DEMO_TENANT, subscriptionId: DEMO_SUBSCRIPTION });
  store.putJob(estate.scan);
}
