import { defineGcpCheck, fail, nonEmptyStr, pass, undetermined } from "./checks/define.js";
import catalogueFile from "../../docs/gcp/support-versions.json" with { type: "json" };

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

export function loadSupportVersions(): SupportCatalogue {
  return catalogueFile as SupportCatalogue;
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

const VERSION_FIELD: Record<SupportKind, string> = { sql: "databaseVersion", gke: "currentMasterVersion" };

export const checkGcpSqlGkeSupport = defineGcpCheck({
  checkId: GCP_SQL_GKE_SUPPORT,
  resourceType: [SQL_TYPE, GKE_TYPE],
  prepare: () => {
    const catalogue = loadSupportVersions();
    return { catalogue, byKey: new Map(catalogue.entries.map((entry) => [`${entry.kind}:${entry.version}`, entry])) };
  },
  readFacts: (resource, fields) => {
    const kind: SupportKind = resource.resourceType === SQL_TYPE ? "sql" : "gke";
    return { kind, version: nonEmptyStr(fields, VERSION_FIELD[kind]) };
  },
  decide: ({ kind, version }, { resource, shared: { catalogue, byKey } }) => {
    const identity = {
      resourceUri: resource.resourceUri,
      resourceName: resource.resourceUri.split("/").pop() ?? resource.displayName,
      resourceKind: kind,
    };
    if (version === null) {
      return undetermined("An instance or cluster read that includes the engine version", {
        ...identity,
        version: null,
        supportEnd: null,
      });
    }
    const listed = byKey.get(`${kind}:${version}`);
    if (listed && listed.supportEnd <= catalogue.publishedAt) {
      return fail({ ...identity, version, supportEnd: listed.supportEnd, source: listed.source });
    }
    return pass({
      ...identity,
      version,
      supportEnd: listed?.supportEnd ?? null,
      source: catalogue.source,
      cataloguePublishedAt: catalogue.publishedAt,
    });
  },
});
