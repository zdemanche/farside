import type { Cloud, Finding } from "@farside/scan-contracts";
import type { CoverageEntry, CoverageState } from "./coverage.js";

export type IssueStatus = "open" | "closed" | "not_confirmed";

export type StoredIssue = {
  id: string;
  checkId: string;
  resourceId: string;
  scopeId: string;
  cloud: Cloud;
  subscriptionOrProject: string;
  status: IssueStatus;
  evidence: Record<string, string | number | boolean | null>;
  savings?: { min: string; max: string; currency: string };
  coverage: CoverageState;
  firstSeen: string;
  lastConfirmed: string;
  closingScanId?: string;
  notConfirmedReason?: string;
};

const RESOURCE_KEYS = [
  "diskId",
  "snapshotId",
  "publicIpId",
  "vmId",
  "planId",
  "loadBalancerId",
  "natGatewayId",
  "sqlResourceId",
  "databaseId",
  "certificateId",
  "gatewayId",
  "reservationId",
  "savingsPlanId",
  "subscriptionId",
  "resourceId",
] as const;

export function resourceIdFromFinding(finding: Finding): string {
  for (const key of RESOURCE_KEYS) {
    const value = finding.evidence.fields[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return finding.scope.id;
}

export function issueIdentity(checkId: string, resourceId: string, scopeId: string): string {
  return `${checkId}:${resourceId}:${scopeId}`;
}

function coverageFor(entries: CoverageEntry[], scopeId: string): CoverageEntry | undefined {
  return entries.find((entry) => entry.id === scopeId);
}

export function applyScanToIssues(input: {
  issues: StoredIssue[];
  findings: Finding[];
  coverage: CoverageEntry[];
  scanId: string;
  observedAt: string;
  checkIds?: readonly string[];
}): StoredIssue[] {
  const limit = input.checkIds ? new Set(input.checkIds) : null;
  const byId = new Map(input.issues.map((issue) => [issue.id, { ...issue }]));
  const seen = new Set<string>();

  for (const finding of input.findings) {
    if (limit && !limit.has(finding.checkId)) {
      continue;
    }
    if (finding.result !== "fail") {
      continue;
    }
    const resourceId = resourceIdFromFinding(finding);
    const id = issueIdentity(finding.checkId, resourceId, finding.scope.id);
    seen.add(id);
    const current = byId.get(id);
    const next: StoredIssue = {
      id,
      checkId: finding.checkId,
      resourceId,
      scopeId: finding.scope.id,
      cloud: finding.scope.cloud,
      subscriptionOrProject: finding.scope.subscriptionOrProject,
      status: "open",
      evidence: { ...finding.evidence.fields },
      coverage: "assessed",
      firstSeen: current?.firstSeen ?? input.observedAt,
      lastConfirmed: input.observedAt,
    };
    if (finding.savings) {
      next.savings = finding.savings;
    }
    byId.set(id, next);
  }

  for (const issue of byId.values()) {
    if (seen.has(issue.id) || issue.status === "closed") {
      continue;
    }
    if (limit && !limit.has(issue.checkId)) {
      continue;
    }
    const coverage = coverageFor(input.coverage, issue.scopeId);
    if (coverage?.state === "assessed") {
      issue.status = "closed";
      issue.coverage = "assessed";
      issue.closingScanId = input.scanId;
      delete issue.notConfirmedReason;
    } else {
      issue.status = "not_confirmed";
      issue.coverage = coverage?.state ?? "unassessed";
      issue.notConfirmedReason =
        coverage?.reason ?? "This scan did not cover the issue scope, so Farside could not confirm it.";
      delete issue.closingScanId;
    }
    byId.set(issue.id, issue);
  }

  return [...byId.values()];
}
