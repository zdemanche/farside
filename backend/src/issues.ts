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
  closedReason?: string;
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

function legacyResourceIdFromFinding(finding: Finding): string {
  for (const key of RESOURCE_KEYS) {
    const value = finding.evidence.fields[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return finding.scope.id;
}

export function resourceIdFromFinding(finding: Finding): string {
  const uri = finding.evidence.fields.resourceUri;
  return typeof uri === "string" && uri.length > 0 ? uri : legacyResourceIdFromFinding(finding);
}

export function issueIdentity(checkId: string, resourceId: string, scopeId: string): string {
  return `${checkId}:${resourceId}:${scopeId}`;
}

function rekeyLegacyIssues(byId: Map<string, StoredIssue>, findings: readonly Finding[]): void {
  for (const finding of findings) {
    if (finding.result === "pass") {
      continue;
    }
    const resourceId = resourceIdFromFinding(finding);
    const id = issueIdentity(finding.checkId, resourceId, finding.scope.id);
    const legacyId = issueIdentity(finding.checkId, legacyResourceIdFromFinding(finding), finding.scope.id);
    const legacy = byId.get(legacyId);
    if (legacyId === id || !legacy || byId.has(id)) {
      continue;
    }
    byId.delete(legacyId);
    byId.set(id, { ...legacy, id, resourceId });
  }
}

export function applyScanToIssues(input: {
  issues: readonly StoredIssue[];
  findings: readonly Finding[];
  coverage: readonly CoverageEntry[];
  scanId: string;
  observedAt: string;
  checkIds?: readonly string[];
}): StoredIssue[] {
  const limit = input.checkIds ? new Set(input.checkIds) : null;
  const byId = new Map(input.issues.map((issue) => [issue.id, { ...issue }]));
  rekeyLegacyIssues(
    byId,
    limit ? input.findings.filter((finding) => limit.has(finding.checkId)) : input.findings,
  );
  const coverageById = new Map<string, CoverageEntry>();
  for (const entry of input.coverage) {
    if (!coverageById.has(entry.id)) {
      coverageById.set(entry.id, entry);
    }
  }
  const seen = new Set<string>();
  const undetermined = new Map<string, string | undefined>();

  for (const finding of input.findings) {
    if (limit && !limit.has(finding.checkId)) {
      continue;
    }
    const resourceId = resourceIdFromFinding(finding);
    const id = issueIdentity(finding.checkId, resourceId, finding.scope.id);
    if (finding.result === "undetermined") {
      undetermined.set(id, finding.closer);
    }
    if (finding.result !== "fail") {
      continue;
    }
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
    const coverage = coverageById.get(issue.scopeId);
    if (undetermined.has(issue.id)) {
      issue.status = "not_confirmed";
      issue.coverage = "undetermined";
      issue.notConfirmedReason =
        undetermined.get(issue.id) ?? "This scan could not determine the result for this resource.";
      delete issue.closingScanId;
    } else if (coverage?.state === "assessed") {
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
