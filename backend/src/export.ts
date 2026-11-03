import type { DeepReadonly } from "./readonly.js";
import { RAW_PROVIDER_KEYS, type Cloud, type Inventory } from "@farside/scan-contracts";
import type { CostSnapshot } from "./cost.js";
import type { StoredIssue } from "./issues.js";

export const EXPORT_FORMAT = "farside-export/1";
export const EXPORT_KINDS = ["issues", "inventory", "cost"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export type ExportIssueRow = {
  id: string;
  checkId: string;
  resourceId: string;
  scopeId: string;
  cloud: Cloud;
  subscriptionOrProject: string;
  status: StoredIssue["status"];
  coverage: StoredIssue["coverage"];
  firstSeen: string;
  lastConfirmed: string;
  savings: { min: string; max: string; currency: string } | null;
};

export type ExportInventoryRow = {
  cloud: Cloud;
  resourceUri: string;
  resourceType: string;
  region: string;
  displayName: string;
  ownerTag: string | null;
};

export type ExportCostRow = {
  billingScope: string;
  currency: string;
  agreementType: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  amount: string;
  provisional: boolean;
};

export type ExportEnvelope = {
  format: typeof EXPORT_FORMAT;
  kind: ExportKind;
  orgId: string;
  exportedAt: string;
  rows: ExportIssueRow[] | ExportInventoryRow[] | ExportCostRow[];
};

const RAW_KEY_SET = new Set<string>(RAW_PROVIDER_KEYS);

export function exportIssues(orgId: string, issues: readonly StoredIssue[], exportedAt: string): ExportEnvelope {
  return {
    format: EXPORT_FORMAT,
    kind: "issues",
    orgId,
    exportedAt,
    rows: issues.map((issue) => ({
      id: issue.id,
      checkId: issue.checkId,
      resourceId: issue.resourceId,
      scopeId: issue.scopeId,
      cloud: issue.cloud,
      subscriptionOrProject: issue.subscriptionOrProject,
      status: issue.status,
      coverage: issue.coverage,
      firstSeen: issue.firstSeen,
      lastConfirmed: issue.lastConfirmed,
      savings: issue.savings ?? null,
    })),
  };
}

export function exportInventory(
  orgId: string,
  inventory: DeepReadonly<Inventory> | null,
  exportedAt: string,
): ExportEnvelope {
  return {
    format: EXPORT_FORMAT,
    kind: "inventory",
    orgId,
    exportedAt,
    rows: inventory
      ? inventory.resources.map((resource) => ({
          cloud: inventory.cloud,
          resourceUri: resource.resourceUri,
          resourceType: resource.resourceType,
          region: resource.region,
          displayName: resource.displayName,
          ownerTag: resource.ownerTag ?? null,
        }))
      : [],
  };
}

export function exportCost(orgId: string, cost: CostSnapshot | null, exportedAt: string): ExportEnvelope {
  const rows: ExportCostRow[] = [];
  if (cost) {
    for (const figure of [...cost.services, ...cost.months]) {
      rows.push({
        billingScope: figure.billingScope,
        currency: figure.currency,
        agreementType: figure.agreementType,
        name: figure.serviceName,
        periodStart: figure.periodStart,
        periodEnd: figure.periodEnd,
        amount: figure.costAmount,
        provisional: figure.provisional,
      });
    }
  }
  return {
    format: EXPORT_FORMAT,
    kind: "cost",
    orgId,
    exportedAt,
    rows,
  };
}

export function validateExport(input: unknown): string[] {
  const errors: string[] = [];
  walkRaw(input, "", errors);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["export must be an object", ...errors];
  }
  const record = input as Record<string, unknown>;
  if (record.format !== EXPORT_FORMAT) {
    errors.push("format must be farside-export/1");
  }
  if (!EXPORT_KINDS.includes(record.kind as ExportKind)) {
    errors.push("kind must be issues, inventory, or cost");
  }
  if (typeof record.orgId !== "string" || record.orgId.length === 0) {
    errors.push("orgId is required");
  }
  if (typeof record.exportedAt !== "string" || record.exportedAt.length === 0) {
    errors.push("exportedAt is required");
  }
  if (!Array.isArray(record.rows)) {
    errors.push("rows must be an array");
  }
  return errors;
}

function walkRaw(value: unknown, path: string, errors: string[]): void {
  if (value == null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkRaw(item, `${path}[${index}]`, errors));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (RAW_KEY_SET.has(key)) {
      errors.push(`${childPath} is a raw provider payload field`);
    }
    walkRaw(child, childPath, errors);
  }
}

export function exportFilename(kind: ExportKind): string {
  return `farside-${kind}.json`;
}
