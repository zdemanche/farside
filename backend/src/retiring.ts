import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RetiringSku = {
  skuName: string;
  resourceType: string;
  retirementDate: string;
  announcementId: string;
  source: string;
};

export type RetiringSkuCatalogue = {
  version: number;
  publishedAt: string;
  source: string;
  entries: RetiringSku[];
};

const DEFAULT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/azure/retiring-skus.json",
);

export function loadRetiringSkus(path = DEFAULT_PATH): RetiringSkuCatalogue {
  return JSON.parse(readFileSync(path, "utf8")) as RetiringSkuCatalogue;
}

export function retiringSourceErrors(catalogue: RetiringSkuCatalogue): string[] {
  const errors: string[] = [];
  if (!(catalogue.version > 0)) {
    errors.push("catalogue.version is required");
  }
  if (typeof catalogue.publishedAt !== "string" || catalogue.publishedAt.length === 0) {
    errors.push("catalogue.publishedAt is required");
  }
  if (typeof catalogue.source !== "string" || catalogue.source.length === 0) {
    errors.push("catalogue.source is required");
  }
  if (!Array.isArray(catalogue.entries)) {
    return ["catalogue.entries must be an array", ...errors];
  }
  catalogue.entries.forEach((entry, index) => {
    if (typeof entry.source !== "string" || entry.source.length === 0) {
      errors.push(`entries[${index}].source is required`);
    }
    if (typeof entry.skuName !== "string" || entry.skuName.length === 0) {
      errors.push(`entries[${index}].skuName is required`);
    }
    if (typeof entry.retirementDate !== "string" || entry.retirementDate.length === 0) {
      errors.push(`entries[${index}].retirementDate is required`);
    }
    if (typeof entry.announcementId !== "string" || entry.announcementId.length === 0) {
      errors.push(`entries[${index}].announcementId is required`);
    }
  });
  return errors;
}
