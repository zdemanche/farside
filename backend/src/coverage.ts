import {
  assertValid,
  scoreHealth,
  validateCoverage,
  type Cloud,
  type Coverage,
  type Finding,
  type HealthScore,
} from "@farside/scan-contracts";
import { COVERAGE_CAUSES, type CoverageCauseId } from "./causes.js";
import { cloudFromCheckId } from "./cloud.js";

export const AZURE_LAUNCH_CHECK_IDS = [
  "azure-inventory-all-resources",
  "azure-inventory-no-owner-tag",
  "azure-waste-unattached-disks",
  "azure-waste-unassociated-public-ips",
  "azure-waste-old-snapshots",
  "azure-waste-stopped-not-deallocated-vms",
  "azure-waste-empty-app-service-plans",
  "azure-waste-idle-load-balancers",
  "azure-waste-idle-nat-gateways",
  "azure-cost-spend-by-service",
  "azure-cost-month-on-month",
  "azure-cost-reservation-use",
  "azure-cost-savings-plan-use",
  "azure-cost-subscriptions-without-budgets",
  "azure-resilience-prod-vms-outside-backup",
  "azure-resilience-prod-sql-outside-backup",
  "azure-resilience-db-zone-or-geo",
  "azure-lifecycle-retiring-skus",
  "azure-lifecycle-expiring-app-service-certs",
  "azure-lifecycle-expiring-gateway-certs",
] as const;

const HARVEST_ASSESSED = new Set<string>([
  "azure-inventory-all-resources",
  "azure-inventory-no-owner-tag",
]);

export type CoverageState = "assessed" | "unassessed" | "undetermined";

export type CoverageEntry = {
  id: string;
  checkId: string;
  cloud: Cloud;
  subscriptionOrProject: string;
  state: CoverageState;
  causeId?: CoverageCauseId;
  reason?: string;
  closer?: string;
};

export type BlindSpot = {
  id: string;
  checkId: string;
  state: "unassessed" | "undetermined";
  reason: string;
  closer: string;
};

export function scopeId(subscriptionOrProject: string, checkId: string): string {
  return `${subscriptionOrProject}:${checkId}`;
}

export function recordCoverageScope(input: {
  subscriptionOrProject: string;
  checkId: string;
  state: CoverageState;
  causeId?: CoverageCauseId;
  closer?: string;
}): CoverageEntry {
  const cause = input.causeId ? COVERAGE_CAUSES[input.causeId] : undefined;
  const entry: CoverageEntry = {
    id: scopeId(input.subscriptionOrProject, input.checkId),
    checkId: input.checkId,
    cloud: cloudFromCheckId(input.checkId),
    subscriptionOrProject: input.subscriptionOrProject,
    state: input.state,
  };
  if (input.causeId) {
    entry.causeId = input.causeId;
  }
  if (cause?.reason) {
    entry.reason = cause.reason;
  }
  const closer = input.closer ?? cause?.closer;
  if (closer) {
    entry.closer = closer;
  }
  return entry;
}

export function toContractCoverage(entries: CoverageEntry[]): Coverage {
  return {
    scopes: entries.map((entry) => ({
      id: entry.id,
      checkId: entry.checkId,
      assessed: entry.state === "assessed",
    })),
  };
}

export function coverageFromHarvest(
  subscriptions: string[],
  checkIds: readonly string[] = AZURE_LAUNCH_CHECK_IDS,
): CoverageEntry[] {
  const entries: CoverageEntry[] = [];
  for (const subscriptionOrProject of subscriptions) {
    for (const checkId of checkIds) {
      if (HARVEST_ASSESSED.has(checkId)) {
        entries.push(
          recordCoverageScope({
            subscriptionOrProject,
            checkId,
            state: "assessed",
          }),
        );
      } else {
        entries.push(
          recordCoverageScope({
            subscriptionOrProject,
            checkId,
            state: "unassessed",
            causeId: "not_run",
          }),
        );
      }
    }
  }
  return entries;
}

export function applyCoverageResult(
  entries: CoverageEntry[],
  result: {
    subscriptionOrProject: string;
    checkId: string;
    state: CoverageState;
    causeId?: CoverageCauseId;
    closer?: string;
  },
): CoverageEntry[] {
  const next = recordCoverageScope(result);
  return [...entries.filter((entry) => entry.id !== next.id), next];
}

export function blindSpots(entries: CoverageEntry[]): BlindSpot[] {
  return entries.flatMap((entry) => {
    if (entry.state === "assessed") {
      return [];
    }
    return [
      {
        id: entry.id,
        checkId: entry.checkId,
        state: entry.state,
        reason: entry.reason ?? "Farside could not check this scope.",
        closer: entry.closer ?? "A successful scan of this check on the subscription.",
      },
    ];
  });
}

export function coverageHealth(entries: CoverageEntry[], findings: Finding[]): HealthScore {
  const coverage = toContractCoverage(entries);
  assertValid(validateCoverage(coverage));
  return scoreHealth(coverage, findings);
}
