import {
  HEALTH_SCORE_FORMULA,
  scoreHealth,
  type Finding,
  type InventoryRecord,
} from "@farside/scan-contracts";
import { DataError } from "./error";
import { formatEvidence, toMoney, lifecycleFrom, recoveryFrom } from "./derive";
import type {
  BlindSpot,
  CostWasteView,
  DataSource,
  EstateOverview,
  InventoryRow,
  IssueRow,
  IssueStatus,
  OrgSettings,
  ScanCheckRow,
  ScanCheckState,
  ScanCoverageSummary,
  ScanRow,
} from "./types";

const SUBSCRIPTION = "main";
const AS_OF = "2026-10-15T12:00:00.000Z";
const FIRST_SCAN_AT = "2026-10-14T12:00:00.000Z";
const NOT_RUN = "This check has not run on this subscription yet.";
const NOT_RUN_CLOSER = "Run a scan after connect, or wait for the unattended scan.";

const DEMO_RESOURCES: InventoryRecord[] = [
  {
    resourceUri:
      "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/disk-unattached",
    resourceType: "Microsoft.Compute/disks",
    region: "eastus",
    displayName: "Unattached managed disk",
    tags: {},
    ownerTag: null,
  },
  {
    resourceUri:
      "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/disk-attached",
    resourceType: "Microsoft.Compute/disks",
    region: "eastus",
    displayName: "Disk attached to the deallocated VM",
    tags: { owner: "farside-test" },
    ownerTag: "farside-test",
  },
  {
    resourceUri:
      "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/virtualMachines/vm-prod-no-backup",
    resourceType: "Microsoft.Compute/virtualMachines",
    region: "westus",
    displayName: "Production VM",
    tags: { owner: "farside-test", environment: "prod" },
    ownerTag: "farside-test",
  },
  {
    resourceUri:
      "/subscriptions/empty-no-budget/resourceGroups/farside-seed/providers/Microsoft.Network/publicIPAddresses/pip-unassociated",
    resourceType: "Microsoft.Network/publicIPAddresses",
    region: "eastus",
    displayName: "Public IP with no ipConfiguration",
    tags: { owner: "farside-test" },
    ownerTag: "farside-test",
  },
];

type CoverageSeed = { checkId: string; state: ScanCheckState; reason?: string; closer?: string };

const ASSESSED_CHECKS = [
  "azure-inventory-all-resources",
  "azure-inventory-no-owner-tag",
  "azure-waste-unattached-disks",
  "azure-waste-unassociated-public-ips",
  "azure-waste-old-snapshots",
  "azure-waste-stopped-not-deallocated-vms",
  "azure-waste-empty-app-service-plans",
  "azure-waste-idle-load-balancers",
  "azure-waste-idle-nat-gateways",
  "azure-resilience-prod-vms-outside-backup",
  "azure-resilience-prod-sql-outside-backup",
  "azure-resilience-db-zone-or-geo",
  "azure-lifecycle-retiring-skus",
  "azure-lifecycle-expiring-app-service-certs",
  "azure-lifecycle-expiring-gateway-certs",
];

const COVERAGE: CoverageSeed[] = [
  ...ASSESSED_CHECKS.map((checkId) => ({ checkId, state: "assessed" as const })),
  {
    checkId: "azure-cost-reservation-use",
    state: "undetermined",
    reason:
      "Farside is missing a required Azure role on this subscription, so this check did not finish.",
    closer: "Grant Reservations Reader on the subscription, then run a scan.",
  },
  {
    checkId: "azure-cost-spend-by-service",
    state: "unassessed",
    reason: "Azure throttled the API call for this check, so Farside stopped short of a result.",
    closer: "Wait and run the scan again. The next unattended run will retry.",
  },
  ...[
    "azure-cost-month-on-month",
    "azure-cost-savings-plan-use",
    "azure-cost-subscriptions-without-budgets",
  ].map((checkId) => ({
    checkId,
    state: "unassessed" as const,
    reason: NOT_RUN,
    closer: NOT_RUN_CLOSER,
  })),
];

const scopeOf = (checkId: string) => ({
  id: `${SUBSCRIPTION}:${checkId}`,
  cloud: "azure" as const,
  subscriptionOrProject: SUBSCRIPTION,
});

function finding(
  checkId: string,
  result: Finding["result"],
  fields: Finding["evidence"]["fields"],
): Finding {
  return { checkId, result, evidence: { fields }, scope: scopeOf(checkId) };
}

const VM_BACKUP = "azure-resilience-prod-vms-outside-backup";
const SQL_BACKUP = "azure-resilience-prod-sql-outside-backup";
const PRODUCTION = { productionMarker: "environment=prod", productionCount: 2 };

const RECOVERY_FINDINGS: Finding[] = [
  finding(VM_BACKUP, "fail", { vmId: "vm-prod-no-backup", ...PRODUCTION, protected: false }),
  finding(VM_BACKUP, "pass", { vmId: "vm-prod-backed-up", ...PRODUCTION, protected: true }),
  finding(SQL_BACKUP, "fail", {
    sqlResourceId: "sql-prod-no-backup",
    ...PRODUCTION,
    protected: false,
  }),
  finding(SQL_BACKUP, "pass", {
    sqlResourceId: "sql-prod-backed-up",
    ...PRODUCTION,
    protected: true,
  }),
  finding("azure-resilience-db-zone-or-geo", "fail", {
    databaseId: "db-no-zone-geo",
    zoneRedundant: false,
    backupRedundancy: "Local",
  }),
];

const LIFECYCLE_FINDINGS: Finding[] = [
  finding("azure-lifecycle-expiring-app-service-certs", "fail", {
    certificateId: "cert-app-expiring",
    hostName: "cert-app-expiring",
    expirationDate: "2026-11-22",
    daysRemaining: 38,
  }),
  finding("azure-lifecycle-expiring-gateway-certs", "fail", {
    gatewayId: "cert-gateway-expiring",
    certificateName: "cert-gateway-expiring",
    expirationDate: "2026-11-22",
    daysRemaining: 38,
  }),
  finding("azure-lifecycle-retiring-skus", "fail", {
    resourceId: "vm-retiring-sku",
    skuName: "Standard_B1ls",
    retirementDate: "2026-12-31",
    source: "docs/azure/retiring-skus.json",
  }),
];

type IssueSeed = {
  id: string;
  checkId: string;
  status: IssueStatus;
  fields: Finding["evidence"]["fields"];
  savings?: { min: string; max: string; currency: string };
  closingScanId?: string;
};

const usd = (min: string, max: string) => ({ min, max, currency: "USD" });

const ISSUE_SEEDS: IssueSeed[] = [
  {
    id: "disk-unattached",
    checkId: "azure-waste-unattached-disks",
    status: "open",
    fields: { diskState: "Unattached", sizeGb: 128, region: "eastus" },
    savings: usd("8.00", "12.00"),
  },
  {
    id: "snapshot-old",
    checkId: "azure-waste-old-snapshots",
    status: "open",
    fields: { ageDays: 90, retentionDays: 30 },
    savings: usd("1.00", "3.00"),
  },
  {
    id: "pip-unassociated",
    checkId: "azure-waste-unassociated-public-ips",
    status: "open",
    fields: { associatedTo: "none" },
    savings: usd("3.00", "5.00"),
  },
  {
    id: "vm-stopped-allocated",
    checkId: "azure-waste-stopped-not-deallocated-vms",
    status: "open",
    fields: { powerState: "stopped", vmSize: "Standard_B2s", region: "eastus" },
    savings: usd("30.40", "45.60"),
  },
  {
    id: "plan-empty",
    checkId: "azure-waste-empty-app-service-plans",
    status: "open",
    fields: { numberOfSites: 0, skuName: "S1" },
    savings: usd("70.00", "105.00"),
  },
  {
    id: "lb-idle",
    checkId: "azure-waste-idle-load-balancers",
    status: "open",
    fields: { backendAddressCount: 0, metricWindow: "7d" },
    savings: usd("18.00", "27.00"),
  },
  {
    id: "nat-idle",
    checkId: "azure-waste-idle-nat-gateways",
    status: "open",
    fields: { attachedSubnetCount: 0, metricWindow: "7d" },
    savings: usd("32.00", "48.00"),
  },
  {
    id: "disk-fixed",
    checkId: "azure-waste-unattached-disks",
    status: "closed",
    fields: { diskState: "Attached" },
    savings: usd("8.00", "12.00"),
    closingScanId: "scan-1",
  },
  {
    id: "sub-no-budget",
    checkId: "azure-cost-subscriptions-without-budgets",
    status: "not_confirmed",
    fields: { budgetCount: 0 },
  },
];

const coverageOf = (checkId: string): CoverageSeed => {
  const seed = COVERAGE.find((entry) => entry.checkId === checkId);
  if (!seed) {
    throw new Error(`demo estate has no coverage for ${checkId}`);
  }
  return seed;
};

function issueRow(seed: IssueSeed): IssueRow {
  const coverage = coverageOf(seed.checkId);
  return {
    id: seed.id,
    checkId: seed.checkId,
    resourceId: seed.id,
    subscription: SUBSCRIPTION,
    status: seed.status,
    evidence: formatEvidence(seed.fields),
    savings: toMoney(seed.savings),
    coverage: coverage.state,
    firstSeen: FIRST_SCAN_AT,
    lastConfirmed: FIRST_SCAN_AT,
    ...(seed.closingScanId ? { closingScanId: seed.closingScanId } : {}),
    ...(seed.status === "not_confirmed" && coverage.reason
      ? { notConfirmedReason: coverage.reason }
      : {}),
  };
}

const ISSUES = ISSUE_SEEDS.map(issueRow);

const FINDINGS: Finding[] = [
  ...ISSUE_SEEDS.filter((seed) => seed.status === "open").map((seed) =>
    finding(seed.checkId, "fail", { resourceId: seed.id }),
  ),
  ...RECOVERY_FINDINGS,
  ...LIFECYCLE_FINDINGS,
];

function summarize(checks: ScanCheckRow[]): ScanCoverageSummary {
  const summary = { assessed: 0, unassessed: 0, undetermined: 0 };
  for (const check of checks) {
    summary[check.state] += 1;
  }
  return summary;
}

const SUCCEEDED_CHECKS: ScanCheckRow[] = COVERAGE.map(({ checkId, state, reason, closer }) => ({
  checkId,
  state,
  ...(reason ? { reason } : {}),
  ...(closer ? { closer } : {}),
}));

const FAILED_CHECKS: ScanCheckRow[] = COVERAGE.map(({ checkId }) => ({
  checkId,
  state: "unassessed",
  reason: "Scan failed before this check ran.",
}));

const SCANS: ScanRow[] = [
  {
    id: "scan-1",
    subscriptionId: SUBSCRIPTION,
    status: "succeeded",
    complete: true,
    current: true,
    startedAt: FIRST_SCAN_AT,
    durationMs: 1200,
    error: null,
    coverageSummary: summarize(SUCCEEDED_CHECKS),
    checks: SUCCEEDED_CHECKS,
  },
  {
    id: "scan-2",
    subscriptionId: SUBSCRIPTION,
    status: "failed",
    complete: false,
    current: false,
    startedAt: AS_OF,
    durationMs: 400,
    error: "Resource Graph call failed",
    coverageSummary: summarize(FAILED_CHECKS),
    checks: FAILED_CHECKS,
  },
];

const HEALTH = scoreHealth(
  {
    scopes: COVERAGE.map(({ checkId, state }) => ({
      id: scopeOf(checkId).id,
      checkId,
      assessed: state === "assessed",
    })),
  },
  FINDINGS,
);

const OVERVIEW: EstateOverview = {
  empty: false,
  resourceTotal: DEMO_RESOURCES.length,
  noOwnerTotal: DEMO_RESOURCES.filter((resource) => !resource.ownerTag).length,
  coverage: summarize(SUCCEEDED_CHECKS),
  healthScore: HEALTH.score,
};

const BLIND_SPOTS: BlindSpot[] = COVERAGE.flatMap(({ checkId, state, reason, closer }) =>
  state === "assessed"
    ? []
    : [
        {
          id: scopeOf(checkId).id,
          checkId,
          state,
          reason: reason ?? NOT_RUN,
          closer: closer ?? NOT_RUN_CLOSER,
        },
      ],
);

const DEFAULT_SETTINGS: OrgSettings = {
  ownerTagKey: "owner",
  productionTagKey: "environment",
  productionTagValue: "prod",
  snapshotRetentionDays: 30,
  certExpiryFlagDays: 60,
  scanScheduleEnabled: true,
  scanIntervalHours: 24,
  scanRetryLimit: 3,
};

function inventoryRow(resource: InventoryRecord): InventoryRow {
  const parts = resource.resourceUri.split("/");
  const at = parts.findIndex((part) => part === "subscriptions" || part === "projects");
  return {
    ...resource,
    cloud: resource.resourceUri.startsWith("//") ? "gcp" : "azure",
    subscriptionOrProject: at === -1 ? "" : (parts[at + 1] ?? ""),
  };
}

const COST_WASTE: CostWasteView = {
  readable: true,
  reason: null,
  spend: {
    currency: "USD",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    provisionalDate: null,
    services: [
      { serviceName: "Virtual Machines", costAmount: "1840.00", provisional: false },
      { serviceName: "Storage", costAmount: "412.50", provisional: false },
    ],
    monthOnMonth: [
      {
        serviceName: "Virtual Machines",
        currentMonthCost: "1840.00",
        previousMonthCost: "1600.00",
        deltaAmount: "240.00",
        deltaPercent: "15.00",
      },
    ],
  },
  floorBurst: [
    { date: "2026-10-30", actual: "74.00", floor: "58.00", burst: "16.00", currency: "USD" },
  ],
  commitments: {
    reservations: [],
    savingsPlans: [],
    noneFound: { reservations: true, savingsPlans: true },
  },
  waste: [
    {
      checkId: "azure-waste-unattached-disks",
      resourceId: "disk-orphan-1",
      subscriptionId: "sub-demo",
      evidence: { diskId: "disk-orphan-1", sizeGb: 128 },
      savings: { min: "9.00", max: "12.00", currency: "USD" },
      issueHref: "#issues/disk-orphan-1",
    },
  ],
  totals: { min: "9.00", max: "12.00", currency: "USD", assessedCount: 1, unassessedScopes: 2 },
};

export function demoSource(): DataSource {
  let settings = DEFAULT_SETTINGS;
  return {
    mode: "demo",
    orgId: "demo",
    overview: async () => OVERVIEW,
    inventory: async () => DEMO_RESOURCES.map(inventoryRow),
    issues: async () => ISSUES,
    costWaste: async () => COST_WASTE,
    scans: async () => SCANS,
    scan: async (id) => {
      const scan = SCANS.find((row) => row.id === id);
      if (!scan) {
        throw new DataError("not-found", 404, "404 Not found");
      }
      return scan;
    },
    blindSpots: async () => ({
      spots: BLIND_SPOTS,
      leftOut: HEALTH.unassessedScopes,
      total: HEALTH.assessedScopes + HEALTH.unassessedScopes,
      formula: HEALTH_SCORE_FORMULA,
    }),
    recovery: async () => recoveryFrom(FINDINGS),
    lifecycle: async () => lifecycleFrom(FINDINGS, AS_OF),
    settings: async () => settings,
    saveSettings: async (next) => {
      settings = next;
      return settings;
    },
    connect: async () => ({
      scanStarted: false,
      attention: "Demo mode: nothing was connected and no scan was started.",
    }),
  };
}
