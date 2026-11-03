#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lintSpec } from "../azure-spec/lint.mjs";
import { REQUIRED_GCP_LAUNCH_CHECK_IDS } from "../reuse-review/lint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_SPEC_PATH = join(ROOT, "docs/gcp/launch-checks.json");

export function lintGcpSpec(spec) {
  const errors = lintSpec(spec, REQUIRED_GCP_LAUNCH_CHECK_IDS);
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return errors;
  }
  if (spec.cloud !== "gcp") {
    errors.push("spec.cloud must be 'gcp'");
  }
  if (!Array.isArray(spec.checks)) {
    return errors;
  }
  for (const [index, check] of spec.checks.entries()) {
    if (!check || typeof check !== "object") {
      continue;
    }
    if (typeof check.billingExportRequired !== "boolean") {
      errors.push(`checks[${index}] is missing required field 'billingExportRequired'`);
    }
    if (check.group === "cost" && check.billingExportRequired !== true) {
      errors.push(`checks[${index}] is a cost check and must require the billing export`);
    }
  }
  return errors;
}

export function lintGcpSpecFile(path = DEFAULT_SPEC_PATH) {
  return lintGcpSpec(JSON.parse(readFileSync(path, "utf8")));
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = lintGcpSpecFile();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log(`gcp spec ok: ${REQUIRED_GCP_LAUNCH_CHECK_IDS.length} launch checks`);
}
