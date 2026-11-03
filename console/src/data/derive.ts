import type { Finding } from "@farside/scan-contracts";
import type { LifecycleView, RecoveryView } from "./types";

type Fields = Finding["evidence"]["fields"];

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
  "resourceName",
  "certificateId",
  "gatewayId",
  "resourceId",
];

const DAY_MS = 86_400_000;
const LIFECYCLE_WINDOW_DAYS = 90;

function resourceIdOf(fields: Fields, fallback: string): string {
  for (const key of RESOURCE_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return fallback;
}

export function formatEvidence(fields: Fields): string {
  return Object.entries(fields)
    .filter(([key, value]) => value !== null && !RESOURCE_KEYS.includes(key))
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
}

export function formatSavings(savings?: { min: string; max: string; currency: string }): string {
  return savings ? `${savings.min}–${savings.max} ${savings.currency}` : "no estimate";
}

export function recoveryFrom(findings: Finding[]): RecoveryView {
  const resilience = findings.filter((finding) => finding.checkId.includes("-resilience-"));
  const backup = resilience.filter((finding) => finding.checkId.endsWith("-outside-backup"));
  const rows = resilience
    .filter((finding) => finding.result !== "pass")
    .map((finding) => {
      const system = resourceIdOf(finding.evidence.fields, finding.scope.id);
      return {
        id: `${finding.checkId}:${system}`,
        system,
        checkId: finding.checkId,
        evidence: formatEvidence(finding.evidence.fields),
        coverage: finding.result === "fail" ? ("assessed" as const) : ("undetermined" as const),
      };
    });
  const undetermined = backup.filter((finding) => finding.result === "undetermined").length;
  return {
    rows,
    unprotected: backup.filter((finding) => finding.result === "fail").length,
    checked: backup.length - undetermined,
    undetermined,
  };
}

function lifecycleKind(checkId: string): string {
  if (checkId.endsWith("-retiring-skus")) {
    return "sku";
  }
  return checkId.endsWith("-support") ? "support" : "certificate";
}

export function lifecycleFrom(findings: Finding[], asOf: string): LifecycleView {
  const horizon = Date.parse(asOf) + LIFECYCLE_WINDOW_DAYS * DAY_MS;
  const rows = findings
    .filter((finding) => finding.checkId.includes("-lifecycle-") && finding.result === "fail")
    .flatMap((finding) => {
      const fields = finding.evidence.fields;
      const dated = fields.retirementDate ?? fields.expirationDate ?? fields.supportEnd;
      if (typeof dated !== "string") {
        return [];
      }
      const resourceId = resourceIdOf(fields, finding.scope.id);
      const title = [fields.skuName, fields.hostName, fields.certificateName].find(
        (value): value is string => typeof value === "string",
      );
      return [
        {
          id: `${finding.checkId}:${resourceId}`,
          date: dated.slice(0, 10),
          kind: lifecycleKind(finding.checkId),
          title: title ?? resourceId,
          source: typeof fields.source === "string" ? fields.source : finding.checkId,
        },
      ];
    })
    .sort((left, right) => left.date.localeCompare(right.date));
  return {
    rows,
    within90: rows.filter((row) => Date.parse(row.date) <= horizon).length,
  };
}
