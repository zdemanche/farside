import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUDS, type Cloud, type Finding } from "@farside/scan-contracts";
import { matchesCloud } from "./cloud.js";
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
  value: Record<string, string | number | boolean | null | object> | null;
};

export type CloudHeadline = {
  cloud: Cloud;
  figures: HeadlineFigure[];
};

export type Headline = {
  sentence: string;
  figures: HeadlineFigure[];
  clouds: CloudHeadline[];
};

const AZURE_WASTE_PREFIX = "azure-waste-";
const GCP_WASTE_PREFIX = "gcp-waste-";
const GCP_SPEND = "gcp-cost-spend-by-service";

const BACKUP_IDS: Record<Cloud, string[]> = {
  azure: [
    "azure-resilience-prod-vms-outside-backup",
    "azure-resilience-prod-sql-outside-backup",
  ],
  gcp: ["gcp-resilience-sql-ha-or-backup"],
};

const LIFECYCLE_IDS: Record<Cloud, string[]> = {
  azure: [
    "azure-lifecycle-retiring-skus",
    "azure-lifecycle-expiring-app-service-certs",
    "azure-lifecycle-expiring-gateway-certs",
  ],
  gcp: ["gcp-lifecycle-sql-gke-support", "gcp-lifecycle-expiring-certs"],
};

type SpecFile = { checks: Array<{ id: string; liveRunAt: string | null }> };

const AZURE_SPEC = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/launch-checks.json"), "utf8"),
) as SpecFile;

const GCP_SPEC = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/gcp/launch-checks.json"), "utf8"),
) as SpecFile;

export function runRecordsFromSpec(specs: SpecFile[] = [AZURE_SPEC, GCP_SPEC]): RunRecord[] {
  return specs.flatMap((spec) =>
    spec.checks.flatMap((check) =>
      check.liveRunAt ? [{ checkId: check.id, liveRunAt: check.liveRunAt }] : [],
    ),
  );
}

export function isProven(checkId: string, records: RunRecord[]): boolean {
  return records.some((record) => record.checkId === checkId);
}

function wastePrefix(cloud: Cloud): string {
  return cloud === "gcp" ? GCP_WASTE_PREFIX : AZURE_WASTE_PREFIX;
}

function spendCheckId(cloud: Cloud): string {
  return cloud === "gcp" ? GCP_SPEND : SPEND_BY_SERVICE;
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

function backupCounts(findings: Finding[], coverage: CoverageEntry[], records: RunRecord[], cloud: Cloud) {
  const relevant = findings.filter(
    (finding) =>
      BACKUP_IDS[cloud].includes(finding.checkId) &&
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

function lifecycleCount(
  findings: Finding[],
  coverage: CoverageEntry[],
  records: RunRecord[],
  cloud: Cloud,
): number {
  return findings.filter(
    (finding) =>
      LIFECYCLE_IDS[cloud].includes(finding.checkId) &&
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

function costForCloud(input: {
  cost?: CostSnapshot | null;
  costs?: Partial<Record<Cloud, CostSnapshot | null>>;
  cloud: Cloud;
}): CostSnapshot | null {
  if (input.costs && Object.prototype.hasOwnProperty.call(input.costs, input.cloud)) {
    return input.costs[input.cloud] ?? null;
  }
  if (input.cloud === "azure") {
    return input.cost ?? null;
  }
  return null;
}

export function buildCloudFigures(input: {
  cloud: Cloud;
  cost: CostSnapshot | null;
  findings: Finding[];
  coverage: CoverageEntry[];
  records: RunRecord[];
}): HeadlineFigure[] {
  const prefix = wastePrefix(input.cloud);
  const spendId = spendCheckId(input.cloud);
  const findings = input.findings.filter((finding) => matchesCloud(finding.scope.cloud, input.cloud));
  const coverage = input.coverage.filter((entry) => matchesCloud(entry.cloud, input.cloud));
  const wasteChecks = [
    ...new Set(findings.filter((finding) => finding.checkId.startsWith(prefix)).map((finding) => finding.checkId)),
    ...coverage.filter((entry) => entry.checkId.startsWith(prefix)).map((entry) => entry.checkId),
  ];
  const uniqueWaste = [...new Set(wasteChecks)];
  const provenWasteFindings = findings.filter(
    (finding) => isWasteFinding(finding) && isProven(finding.checkId, input.records),
  );
  const provenWasteCoverage = coverage.filter(
    (entry) => entry.checkId.startsWith(prefix) && isProven(entry.checkId, input.records),
  );
  const spendStatus = !isProven(spendId, input.records)
    ? "not_supported"
    : input.cost && coverage.some((entry) => entry.checkId === spendId && entry.state === "assessed")
      ? "ok"
      : "not_assessed";
  const wasteStatus = groupStatus(
    uniqueWaste.length > 0 ? uniqueWaste : [`${prefix}unattached-disks`],
    coverage,
    input.records,
  );
  const backupStatus = groupStatus(BACKUP_IDS[input.cloud], coverage, input.records);
  const lifecycleStatus = groupStatus(LIFECYCLE_IDS[input.cloud], coverage, input.records);
  const unseenStatus = input.records.some((record) => record.checkId.startsWith(`${input.cloud}-`))
    ? "ok"
    : "not_supported";
  const totals = wasteTotals(provenWasteFindings, provenWasteCoverage);
  const backup = backupCounts(findings, coverage, input.records, input.cloud);
  const losingSupport = lifecycleCount(findings, coverage, input.records, input.cloud);
  const unseen = coverage.filter(
    (entry) => isProven(entry.checkId, input.records) && entry.state !== "assessed",
  ).length;
  return [
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
}

function pickMoneyValue(figures: CloudHeadline[], id: "monthlyCost" | "waste"): HeadlineFigure["value"] {
  const ok = figures.flatMap((cloud) => {
    const found = cloud.figures.find((figure) => figure.id === id);
    return found?.status === "ok" && found.value ? [{ cloud: cloud.cloud, value: found.value }] : [];
  });
  if (ok.length === 0) {
    return null;
  }
  if (ok.length === 1) {
    return ok[0]?.value ?? null;
  }
  const currencies = new Set(
    ok.map((item) => (typeof item.value.currency === "string" ? item.value.currency : "")).filter(Boolean),
  );
  if (currencies.size > 1) {
    return {
      byCloud: Object.fromEntries(ok.map((item) => [item.cloud, item.value])),
      mixedCurrencies: true,
    };
  }
  return { byCloud: Object.fromEntries(ok.map((item) => [item.cloud, item.value])), mixedCurrencies: false };
}

function pickCountValue(
  figures: CloudHeadline[],
  id: "backup" | "lifecycle" | "unseen",
): HeadlineFigure["value"] {
  const ok = figures.flatMap((cloud) => {
    const found = cloud.figures.find((figure) => figure.id === id);
    return found?.status === "ok" && found.value ? [found.value] : [];
  });
  if (ok.length === 0) {
    return null;
  }
  if (id === "backup") {
    return {
      unprotected: ok.reduce((sum, value) => sum + (Number(value.unprotected) || 0), 0),
      production: ok.reduce((sum, value) => sum + (Number(value.production) || 0), 0),
    };
  }
  return { count: ok.reduce((sum, value) => sum + (Number(value.count) || 0), 0) };
}

function combineStatus(figures: CloudHeadline[], id: HeadlineFigure["id"]): HeadlineStatus {
  const statuses = figures.flatMap((cloud) => {
    const found = cloud.figures.find((figure) => figure.id === id);
    return found ? [found.status] : [];
  });
  if (statuses.includes("ok")) {
    return "ok";
  }
  if (statuses.includes("not_assessed")) {
    return "not_assessed";
  }
  return "not_supported";
}

export function buildHeadline(input: {
  cost?: CostSnapshot | null;
  costs?: Partial<Record<Cloud, CostSnapshot | null>>;
  findings: Finding[];
  coverage: CoverageEntry[];
  records?: RunRecord[];
  cloud?: Cloud;
}): Headline {
  const records = input.records ?? runRecordsFromSpec();
  const selected = input.cloud ? [input.cloud] : [...CLOUDS];
  const clouds = selected.map((cloud) => ({
    cloud,
    figures: buildCloudFigures({
      cloud,
      cost: costForCloud({
        cloud,
        ...(input.cost !== undefined ? { cost: input.cost } : {}),
        ...(input.costs !== undefined ? { costs: input.costs } : {}),
      }),
      findings: input.findings,
      coverage: input.coverage,
      records,
    }),
  }));
  const figures: HeadlineFigure[] = [
    figure(
      "monthlyCost",
      "Monthly cost",
      "#cost-and-waste",
      combineStatus(clouds, "monthlyCost"),
      pickMoneyValue(clouds, "monthlyCost"),
    ),
    figure(
      "waste",
      "Nameable waste",
      "#issues",
      combineStatus(clouds, "waste"),
      pickMoneyValue(clouds, "waste"),
    ),
    figure(
      "backup",
      "Production systems not backed up",
      "#recovery",
      combineStatus(clouds, "backup"),
      pickCountValue(clouds, "backup"),
    ),
    figure(
      "lifecycle",
      "Things losing support in 90 days",
      "#lifecycle",
      combineStatus(clouds, "lifecycle"),
      pickCountValue(clouds, "lifecycle"),
    ),
    figure(
      "unseen",
      "What Farside could not see",
      "#blind-spots",
      combineStatus(clouds, "unseen"),
      pickCountValue(clouds, "unseen"),
    ),
  ];
  return {
    sentence:
      "Your Azure and GCP costs, nameable waste, backup gaps, support losses, and what Farside could not see. Unproven checks are not supported and are left out of every figure. Money figures are per cloud and are never summed across currencies.",
    figures,
    clouds,
  };
}
