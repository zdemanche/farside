import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertValid, validateFinding, type Finding, type Inventory } from "@farside/scan-contracts";
import type { ResourceFacts } from "./facts.js";
import { projectOf } from "./gcp-inventory.js";
import type { OrgSettings } from "./settings.js";
import { DEFAULT_SETTINGS } from "./settings.js";

export const GCP_SQL_GKE_SUPPORT = "gcp-lifecycle-sql-gke-support";

export const SQL_TYPE = "sqladmin.googleapis.com/Instance";
export const GKE_TYPE = "container.googleapis.com/Cluster";

export type SupportKind = "sql" | "gke";

export type SupportVersion = {
  kind: SupportKind;
  version: string;
  supportEnd: string;
  source: string;
};

export type SupportCatalogue = {
  version: number;
  publishedAt: string;
  source: string;
  entries: SupportVersion[];
};

const DEFAULT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/gcp/support-versions.json",
);

export function loadSupportVersions(path = DEFAULT_PATH): SupportCatalogue {
  return JSON.parse(readFileSync(path, "utf8")) as SupportCatalogue;
}

export function supportSourceErrors(catalogue: SupportCatalogue): string[] {
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
    if (entry.kind !== "sql" && entry.kind !== "gke") {
      errors.push(`entries[${index}].kind must be sql or gke`);
    }
    if (typeof entry.version !== "string" || entry.version.length === 0) {
      errors.push(`entries[${index}].version is required`);
    }
    if (typeof entry.supportEnd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.supportEnd)) {
      errors.push(`entries[${index}].supportEnd must be YYYY-MM-DD`);
    }
  });
  return errors;
}

function acceptFinding(finding: Finding): Finding {
  assertValid(validateFinding(finding));
  return finding;
}

function kindOf(resourceType: string): SupportKind | null {
  if (resourceType === SQL_TYPE) {
    return "sql";
  }
  if (resourceType === GKE_TYPE) {
    return "gke";
  }
  return null;
}

function versionOf(fields: ResourceFacts["fields"] | undefined, kind: SupportKind): string | null {
  const key = kind === "sql" ? "databaseVersion" : "currentMasterVersion";
  const value = fields?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function checkGcpSqlGkeSupport(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
  catalogue = loadSupportVersions(),
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  const byKey = new Map(catalogue.entries.map((entry) => [`${entry.kind}:${entry.version}`, entry]));
  return inventory.resources.flatMap((resource) => {
    const kind = kindOf(resource.resourceType);
    if (!kind) {
      return [];
    }
    const row = byUri.get(resource.resourceUri);
    const project = projectOf(resource.resourceUri);
    const scope = {
      id: `${project}:${GCP_SQL_GKE_SUPPORT}`,
      cloud: "gcp" as const,
      subscriptionOrProject: project,
    };
    const resourceName = resource.resourceUri.split("/").pop() ?? resource.displayName;
    const version = versionOf(row?.fields, kind);
    if (version == null) {
      return [
        acceptFinding({
          checkId: GCP_SQL_GKE_SUPPORT,
          result: "undetermined",
          closer: "An instance or cluster read that includes the engine version",
          evidence: {
            fields: { resourceName, resourceKind: kind, version: null, supportEnd: null },
          },
          scope,
        }),
      ];
    }
    const listed = byKey.get(`${kind}:${version}`);
    if (listed && listed.supportEnd <= catalogue.publishedAt) {
      return [
        acceptFinding({
          checkId: GCP_SQL_GKE_SUPPORT,
          result: "fail",
          evidence: {
            fields: {
              resourceName,
              resourceKind: kind,
              version,
              supportEnd: listed.supportEnd,
              source: listed.source,
            },
          },
          scope,
        }),
      ];
    }
    return [
      acceptFinding({
        checkId: GCP_SQL_GKE_SUPPORT,
        result: "pass",
        evidence: {
          fields: {
            resourceName,
            resourceKind: kind,
            version,
            supportEnd: listed?.supportEnd ?? null,
            source: catalogue.source,
            cataloguePublishedAt: catalogue.publishedAt,
          },
        },
        scope,
      }),
    ];
  });
}
