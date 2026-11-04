#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lintSpec } from "../azure-spec/lint.mjs";
import { REQUIRED_GCP_LAUNCH_CHECK_IDS } from "../reuse-review/lint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_SPEC_PATH = join(ROOT, "docs/gcp/launch-checks.json");
const DEFAULT_MATRIX_PATH = join(ROOT, "docs/gcp/support-matrix.md");

function formatLiveRun(liveRunAt) {
  if (liveRunAt == null || liveRunAt === "") {
    return "—";
  }
  return String(liveRunAt);
}

function formatBillingExport(required) {
  return required === true ? "yes" : "no";
}

export function parseGcpMatrixRows(markdown) {
  const rows = [];
  if (typeof markdown !== "string") {
    return rows;
  }
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) {
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 8) {
      continue;
    }
    const id = cells[0];
    if (!id || id === "Check id" || /^-+$/.test(id.replaceAll(":", ""))) {
      continue;
    }
    rows.push({
      id,
      group: cells[1],
      title: cells[2],
      role: cells[3],
      billingExport: cells[4],
      status: cells[5],
      support: cells[6],
      liveRun: cells[7],
    });
  }
  return rows;
}

export function lintGcpMatrix(spec, markdown) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return ["spec must be an object"];
  }
  if (!Array.isArray(spec.checks)) {
    return ["spec.checks must be an array"];
  }
  const errors = [];
  const rows = parseGcpMatrixRows(markdown);
  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.id)) {
      errors.push(`support matrix has duplicate check '${row.id}'`);
    } else {
      byId.set(row.id, row);
    }
  }
  for (const check of spec.checks) {
    if (!check || typeof check !== "object" || typeof check.id !== "string") {
      continue;
    }
    const row = byId.get(check.id);
    if (!row) {
      errors.push(`support matrix is missing launch check '${check.id}'`);
      continue;
    }
    if (row.group !== check.group) {
      errors.push(
        `support matrix '${check.id}' group '${row.group}' does not match spec '${check.group}'`,
      );
    }
    if (row.title !== check.title) {
      errors.push(`support matrix '${check.id}' title does not match spec`);
    }
    if (row.role !== check.role) {
      errors.push(
        `support matrix '${check.id}' role '${row.role}' does not match spec '${check.role}'`,
      );
    }
    const expectedExport = formatBillingExport(check.billingExportRequired);
    if (row.billingExport !== expectedExport) {
      errors.push(
        `support matrix '${check.id}' billing export '${row.billingExport}' does not match spec '${expectedExport}'`,
      );
    }
    if (row.status !== check.status) {
      errors.push(
        `support matrix '${check.id}' status '${row.status}' does not match spec '${check.status}'`,
      );
    }
    if (row.support !== check.support) {
      errors.push(
        `support matrix '${check.id}' support '${row.support}' does not match spec '${check.support}'`,
      );
    }
    const expectedLive = formatLiveRun(check.liveRunAt);
    if (row.liveRun !== expectedLive) {
      errors.push(
        `support matrix '${check.id}' live run '${row.liveRun}' does not match spec '${expectedLive}'`,
      );
    }
  }
  const specIds = new Set(
    spec.checks
      .filter((check) => check && typeof check === "object" && typeof check.id === "string")
      .map((check) => check.id),
  );
  for (const row of rows) {
    if (!specIds.has(row.id)) {
      errors.push(`support matrix has unknown check '${row.id}'`);
    }
  }
  return errors;
}

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

export function lintGcpMatrixFile(
  specPath = DEFAULT_SPEC_PATH,
  matrixPath = DEFAULT_MATRIX_PATH,
) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const markdown = readFileSync(matrixPath, "utf8");
  return lintGcpMatrix(spec, markdown);
}

export function lintGcpSpecFiles(
  specPath = DEFAULT_SPEC_PATH,
  matrixPath = DEFAULT_MATRIX_PATH,
) {
  return [...lintGcpSpecFile(specPath), ...lintGcpMatrixFile(specPath, matrixPath)];
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = lintGcpSpecFiles();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log(`gcp spec ok: ${REQUIRED_GCP_LAUNCH_CHECK_IDS.length} launch checks`);
}
