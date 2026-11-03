import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "@farside/scan-contracts";
import type { CostSnapshot } from "./cost.js";
import { SPEND_BY_SERVICE } from "./cost.js";
import type { CoverageEntry } from "./coverage.js";
import { isAssessedFinding, isWasteFinding, wasteTotals } from "./waste.js";

export type RunRecord = { checkId: string; liveRunAt: string };

export type HeadlineStatus = "ok" | "not_assessed" | "not_supported";

export type HeadlineFigure = {
  id: "monthlyCost" | "waste" | "backup" | "lifecycle" | "unseen";
  label: string;
  href: string;
  status: HeadlineStatus;
  value: Record<string, string | number | null> | null;
};

export type Headline = {
  sentence: string;
  figures: HeadlineFigure[];
};

const WASTE_PREFIX = "azure-waste-";
const BACKUP_IDS = [
  "azure-resilience-prod-vms-outside-backup",
  "azure-resilience-prod-sql-outside-backup",
];
const LIFECYCLE_IDS = [
  "azure-lifecycle-retiring-skus",
  "azure-lifecycle-expiring-app-service-certs",
  "azure-lifecycle-expiring-gateway-certs",
];

type SpecFile = { checks: Array<{ id: string; liveRunAt: string | null }> };

const SPEC = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/launch-checks.json"), "utf8"),
) as SpecFile;

export function runRecordsFromSpec(spec: SpecFile = SPEC): RunRecord[] {
  return spec.checks.flatMap((check) =>
    check.liveRunAt ? [{ checkId: check.id, liveRunAt: check.liveRunAt }] : [],
  );
}

export function isProven(checkId: string, records: RunRecord[]): boolean {
  return records.some((record) => record.checkId === checkId);
}

function figure(
  id: HeadlineFigure["id"],
  label: string,
  href: string,
  status: HeadlineStatus,
  value: HeadlineFigure["value"],
): HeadlineFigure {
  return { id, label, href, status, value: status === "ok" ? value : null };
}

function latestMonthCost(cost: CostSnapshot | null): string | null {
  const last = cost?.months.at(-1);
  return last?.costAmount ?? null;
}

function backupCounts(findings: Finding[], coverage: CoverageEntry[], records: RunRecord[]) {
  const relevant = findings.filter(
    (finding) =>
      BACKUP_IDS.includes(finding.checkId) &&
      isProven(finding.checkId, records) &&
      isAssessedFinding(coverage, finding) &&
      finding.result === "fail",
  );
  const unprotected = relevant.length;
  const production = relevant.reduce((max, finding) => {
    const count = finding.evidence.fields.productionCount;
    return typeof count === "number" && count > max ? count : max;
  }, 0);
  return { unprotected, production };
}

function lifecycleCount(findings: Finding[], coverage: CoverageEntry[], records: RunRecord[]): number {
  return findings.filter(
    (finding) =>
      LIFECYCLE_IDS.includes(finding.checkId) &&
      isProven(finding.checkId, records) &&
      isAssessedFinding(coverage, finding) &&
      finding.result === "fail",
  ).length;
}

function groupStatus(checkIds: string[], coverage: CoverageEntry[], records: RunRecord[]): HeadlineStatus {
  const proven = checkIds.filter((checkId) => isProven(checkId, records));
  if (proven.length === 0) {
    return "not_supported";
  }
  const assessed = proven.some((checkId) =>
    coverage.some((entry) => entry.checkId === checkId && entry.state === "assessed"),
  );
  return assessed ? "ok" : "not_assessed";
}

export function buildHeadline(input: {
  cost: CostSnapshot | null;
  findings: Finding[];
  coverage: CoverageEntry[];
  records?: RunRecord[];
}): Headline {
  const records = input.records ?? runRecordsFromSpec();
  const wasteChecks = [
    ...new Set(input.findings.filter((finding) => finding.checkId.startsWith(WASTE_PREFIX)).map((finding) => finding.checkId)),
    ...input.coverage.filter((entry) => entry.checkId.startsWith(WASTE_PREFIX)).map((entry) => entry.checkId),
  ];
  const uniqueWaste = [...new Set(wasteChecks)];
  const provenWasteFindings = input.findings.filter(
    (finding) => isWasteFinding(finding) && isProven(finding.checkId, records),
  );
  const provenWasteCoverage = input.coverage.filter(
    (entry) => entry.checkId.startsWith(WASTE_PREFIX) && isProven(entry.checkId, records),
  );
  const spendStatus = !isProven(SPEND_BY_SERVICE, records)
    ? "not_supported"
    : input.cost &&
        input.coverage.some((entry) => entry.checkId === SPEND_BY_SERVICE && entry.state === "assessed")
      ? "ok"
      : "not_assessed";
  const wasteStatus = groupStatus(
    uniqueWaste.length > 0 ? uniqueWaste : [`${WASTE_PREFIX}unattached-disks`],
    input.coverage,
    records,
  );
  const backupStatus = groupStatus(BACKUP_IDS, input.coverage, records);
  const lifecycleStatus = groupStatus(LIFECYCLE_IDS, input.coverage, records);
  const unseenStatus = records.length === 0 ? "not_supported" : "ok";
  const totals = wasteTotals(provenWasteFindings, provenWasteCoverage);
  const backup = backupCounts(input.findings, input.coverage, records);
  const losingSupport = lifecycleCount(input.findings, input.coverage, records);
  const unseen = input.coverage.filter(
    (entry) => isProven(entry.checkId, records) && entry.state !== "assessed",
  ).length;
  const figures: HeadlineFigure[] = [
    figure(
      "monthlyCost",
      "Monthly cost",
      "#cost-and-waste",
      spendStatus,
      spendStatus === "ok" ? { amount: latestMonthCost(input.cost), currency: input.cost?.currency ?? "USD" } : null,
    ),
    figure(
      "waste",
      "Nameable waste",
      "#issues",
      wasteStatus,
      wasteStatus === "ok" ? { min: totals.min, max: totals.max, currency: totals.currency } : null,
    ),
    figure(
      "backup",
      "Production systems not backed up",
      "#recovery",
      backupStatus,
      backupStatus === "ok" ? { unprotected: backup.unprotected, production: backup.production } : null,
    ),
    figure(
      "lifecycle",
      "Things losing support in 90 days",
      "#lifecycle",
      lifecycleStatus,
      lifecycleStatus === "ok" ? { count: losingSupport } : null,
    ),
    figure(
      "unseen",
      "What Farside could not see",
      "#blind-spots",
      unseenStatus,
      unseenStatus === "ok" ? { count: unseen } : null,
    ),
  ];
  return {
    sentence:
      "Your Azure costs, nameable waste, backup gaps, support losses, and what Farside could not see. Unproven checks are not supported and are left out of every figure.",
    figures,
  };
}
