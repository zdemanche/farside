import type { Cloud, Finding } from "@farside/scan-contracts";
import type { AlertAnalysis } from "./alerts.js";
import type { CommitmentSnapshot } from "./commitments.js";
import type { CostSnapshot } from "./cost.js";
import type { CoverageEntry } from "./coverage.js";
import { scopeId } from "./coverage.js";
import { issueIdentity, resourceIdFromFinding } from "./issues.js";

export type WasteItem = {
  checkId: string;
  resourceId: string;
  cloud: Cloud;
  subscriptionId: string;
  evidence: Finding["evidence"]["fields"];
  savings: { min: string; max: string; currency: string };
  issueHref: string;
};

export type WasteTotals = {
  min: string;
  max: string;
  currency: string;
  assessedCount: number;
  unassessedScopes: number;
};

export type CostWasteView = {
  readable: boolean;
  reason: string | null;
  spend: CostSnapshot | null;
  floorBurst: AlertAnalysis["floorBurst"] | null;
  commitments: CommitmentSnapshot | null;
  waste: WasteItem[];
  totals: WasteTotals;
  /** How much daily history exists; spend alerts are undetermined until it is long enough. */
  history: {
    days: number | null;
    firstDay: string | null;
    daysNeeded: number | null;
    closer: string | null;
  };
};

function addDecimal(left: string, right: string): string {
  return (Number(left) + Number(right)).toFixed(2);
}

export function wasteResourceId(finding: Finding): string {
  const fields = finding.evidence.fields;
  for (const key of [
    "diskId",
    "snapshotId",
    "snapshotOrImageId",
    "publicIpId",
    "addressId",
    "vmId",
    "planId",
    "loadBalancerId",
    "natGatewayId",
    "recommendationId",
  ]) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return finding.scope.id;
}

export function isWasteFinding(finding: Finding): boolean {
  return /^(azure|gcp)-waste-/.test(finding.checkId) && finding.result === "fail" && finding.savings != null;
}

export function isAssessedFinding(coverage: readonly CoverageEntry[], finding: Finding): boolean {
  const id = scopeId(finding.scope.subscriptionOrProject, finding.checkId);
  return coverage.some((entry) => entry.id === id && entry.state === "assessed");
}

export function wasteTotals(
  findings: readonly Finding[],
  coverage: readonly CoverageEntry[],
): WasteTotals {
  const assessed = findings.filter((finding) => isWasteFinding(finding) && isAssessedFinding(coverage, finding));
  const unassessedScopes = coverage.filter(
    (entry) => /^(azure|gcp)-waste-/.test(entry.checkId) && entry.state !== "assessed",
  ).length;
  const currency = assessed[0]?.savings?.currency ?? "USD";
  return {
    min: assessed.reduce((sum, finding) => addDecimal(sum, finding.savings?.min ?? "0.00"), "0.00"),
    max: assessed.reduce((sum, finding) => addDecimal(sum, finding.savings?.max ?? "0.00"), "0.00"),
    currency,
    assessedCount: assessed.length,
    unassessedScopes,
  };
}

export function costWasteView(input: {
  cost: CostSnapshot | null;
  alerts: AlertAnalysis | null;
  commitments: CommitmentSnapshot | null;
  findings: readonly Finding[];
  coverage: readonly CoverageEntry[];
}): CostWasteView {
  const waste = input.findings.flatMap((finding) => {
    if (!isWasteFinding(finding) || !isAssessedFinding(input.coverage, finding) || !finding.savings) {
      return [];
    }
    const resourceId = wasteResourceId(finding);
    return [
      {
        checkId: finding.checkId,
        resourceId,
        cloud: finding.scope.cloud,
        subscriptionId: finding.scope.subscriptionOrProject,
        evidence: finding.evidence.fields,
        savings: finding.savings,
        // The Issues screen selects by the stored issue id (checkId:resourceId:scopeId).
        issueHref: `#issues/${encodeURIComponent(issueIdentity(finding.checkId, resourceIdFromFinding(finding), finding.scope.id))}`,
      },
    ];
  });
  return {
    readable: input.cost != null,
    reason: input.cost ? null : "cost could not be read",
    spend: input.cost,
    floorBurst: input.alerts?.floorBurst ?? null,
    commitments: input.commitments,
    waste,
    totals: wasteTotals(input.findings, input.coverage),
    history: {
      days: input.alerts?.historyDays ?? null,
      firstDay: input.alerts?.firstDay ?? null,
      daysNeeded: input.alerts?.undetermined?.daysNeeded ?? null,
      closer: input.alerts?.undetermined?.closer ?? null,
    },
  };
}
