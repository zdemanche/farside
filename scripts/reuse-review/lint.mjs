#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MAP_PATH = join(ROOT, "docs/reuse/atlas-check-map.json");
const DEFAULT_SPEC_PATH = join(ROOT, "docs/azure/launch-checks.json");

export const REQUIRED_GCP_LAUNCH_CHECK_IDS = [
  "gcp-inventory-all-assets",
  "gcp-inventory-no-owner-label",
  "gcp-waste-unattached-disks",
  "gcp-waste-unused-external-ips",
  "gcp-waste-old-snapshots-and-images",
  "gcp-waste-idle-vm-and-disk-recommendations",
  "gcp-cost-spend-by-service",
  "gcp-cost-committed-use",
  "gcp-resilience-sql-ha-or-backup",
  "gcp-lifecycle-sql-gke-support",
  "gcp-lifecycle-expiring-certs",
];

const ATLAS_KINDS = new Set(["control", "method", "new"]);
const ATLAS_RELATIONS = new Set(["follows", "new"]);

export function lintReuseMap(map, azureIds) {
  const errors = [];
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return ["map must be an object"];
  }
  if (!Array.isArray(map.checks)) {
    return ["map.checks must be an array"];
  }

  const seen = new Set();
  for (const [index, check] of map.checks.entries()) {
    const label = `checks[${index}]`;
    if (!check || typeof check !== "object") {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof check.id !== "string" || check.id.length === 0) {
      errors.push(`${label}.id must be a non-empty string`);
    } else if (seen.has(check.id)) {
      errors.push(`duplicate check id '${check.id}'`);
    } else {
      seen.add(check.id);
    }
    if (check.cloud !== "azure" && check.cloud !== "gcp") {
      errors.push(`${label}.cloud must be 'azure' or 'gcp'`);
    }
    if (typeof check.title !== "string" || check.title.length === 0) {
      errors.push(`${label}.title must be a non-empty string`);
    }
    const atlas = check.atlas;
    if (!atlas || typeof atlas !== "object") {
      errors.push(`${label}.atlas must be an object`);
    } else {
      if (!ATLAS_KINDS.has(atlas.kind)) {
        errors.push(`${label}.atlas.kind must be control, method, or new`);
      }
      if (!ATLAS_RELATIONS.has(atlas.relation)) {
        errors.push(`${label}.atlas.relation must be follows or new`);
      }
      if (atlas.relation === "new" && atlas.kind !== "new") {
        errors.push(`${label}.atlas.kind must be 'new' when relation is 'new'`);
      }
      if (atlas.relation === "follows" && (atlas.id == null || atlas.id === "")) {
        errors.push(`${label}.atlas.id is required when relation is follows`);
      }
      if (typeof atlas.title !== "string" || atlas.title.length === 0) {
        errors.push(`${label}.atlas.title must be a non-empty string`);
      }
    }
    if (check.costReporter !== null && typeof check.costReporter !== "string") {
      errors.push(`${label}.costReporter must be a string or null`);
    }
  }

  for (const id of azureIds) {
    if (!seen.has(id)) {
      errors.push(`missing Azure launch check '${id}'`);
    }
  }
  for (const id of REQUIRED_GCP_LAUNCH_CHECK_IDS) {
    if (!seen.has(id)) {
      errors.push(`missing GCP launch check '${id}'`);
    }
  }

  return errors;
}

export function lintReuseMapFile(
  mapPath = DEFAULT_MAP_PATH,
  specPath = DEFAULT_SPEC_PATH,
) {
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const azureIds = Array.isArray(spec.checks)
    ? spec.checks.map((check) => check.id).filter((id) => typeof id === "string")
    : [];
  return lintReuseMap(map, azureIds);
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = lintReuseMapFile();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log("reuse map ok: every Azure and GCP launch check is mapped");
}
