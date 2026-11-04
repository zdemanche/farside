#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_CHECK_FIELDS = [
  "id",
  "group",
  "title",
  "role",
  "dataSource",
  "evidenceFields",
  "savingsBasis",
  "undetermined",
  "status",
  "support",
  "liveRunAt",
];

const ALLOWED_GROUPS = new Set([
  "inventory",
  "waste",
  "cost",
  "resilience",
  "lifecycle",
]);

export const REQUIRED_LAUNCH_CHECK_IDS = [
  "azure-inventory-all-resources",
  "azure-inventory-no-owner-tag",
  "azure-waste-unattached-disks",
  "azure-waste-unassociated-public-ips",
  "azure-waste-old-snapshots",
  "azure-waste-stopped-not-deallocated-vms",
  "azure-waste-empty-app-service-plans",
  "azure-waste-idle-load-balancers",
  "azure-waste-idle-nat-gateways",
  "azure-cost-spend-by-service",
  "azure-cost-month-on-month",
  "azure-cost-reservation-use",
  "azure-cost-savings-plan-use",
  "azure-cost-subscriptions-without-budgets",
  "azure-resilience-prod-vms-outside-backup",
  "azure-resilience-prod-sql-outside-backup",
  "azure-resilience-db-zone-or-geo",
  "azure-lifecycle-retiring-skus",
  "azure-lifecycle-expiring-app-service-certs",
  "azure-lifecycle-expiring-gateway-certs",
];

const DEFAULT_SPEC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/azure/launch-checks.json",
);

const DEFAULT_MATRIX_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/azure/support-matrix.md",
);

function formatLiveRun(liveRunAt) {
  if (liveRunAt == null || liveRunAt === "") {
    return "—";
  }
  return String(liveRunAt);
}

export function parseMatrixRows(markdown) {
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
    if (cells.length < 7) {
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
      status: cells[4],
      support: cells[5],
      liveRun: cells[6],
    });
  }
  return rows;
}

export function lintMatrix(spec, markdown) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return ["spec must be an object"];
  }
  if (!Array.isArray(spec.checks)) {
    return ["spec.checks must be an array"];
  }
  const errors = [];
  const rows = parseMatrixRows(markdown);
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

export function lintSpec(spec, requiredIds = REQUIRED_LAUNCH_CHECK_IDS) {
  const errors = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return ["spec must be an object"];
  }
  if (!Array.isArray(spec.checks)) {
    return ["spec.checks must be an array"];
  }

  const seen = new Set();
  for (const [index, check] of spec.checks.entries()) {
    const label = `checks[${index}]`;
    if (!check || typeof check !== "object") {
      errors.push(`${label} must be an object`);
      continue;
    }
    for (const field of REQUIRED_CHECK_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(check, field)) {
        errors.push(`${label} is missing required field '${field}'`);
      }
    }
    if (typeof check.id !== "string" || check.id.length === 0) {
      errors.push(`${label}.id must be a non-empty string`);
    } else if (seen.has(check.id)) {
      errors.push(`duplicate check id '${check.id}'`);
    } else {
      seen.add(check.id);
    }
    if (check.group && !ALLOWED_GROUPS.has(check.group)) {
      errors.push(`${label}.group '${check.group}' is not a launch group`);
    }
    if (typeof check.title !== "string" || check.title.length === 0) {
      errors.push(`${label}.title must be a non-empty string`);
    }
    if (typeof check.role !== "string" || check.role.length === 0) {
      errors.push(`${label}.role must be a non-empty string`);
    }
    if (typeof check.dataSource !== "string" || check.dataSource.length === 0) {
      errors.push(`${label}.dataSource must be a non-empty string`);
    }
    if (!Array.isArray(check.evidenceFields) || check.evidenceFields.length === 0) {
      errors.push(`${label}.evidenceFields must be a non-empty array`);
    }
    if (check.savingsBasis !== null && typeof check.savingsBasis !== "string") {
      errors.push(`${label}.savingsBasis must be a string or null`);
    }
    if (!Array.isArray(check.undetermined) || check.undetermined.length === 0) {
      errors.push(`${label}.undetermined must be a non-empty array`);
    } else {
      for (const [uIndex, item] of check.undetermined.entries()) {
        if (!item || typeof item.when !== "string" || typeof item.closer !== "string") {
          errors.push(
            `${label}.undetermined[${uIndex}] must have string fields 'when' and 'closer'`,
          );
        }
      }
    }
    if (!Object.prototype.hasOwnProperty.call(check, "status") || check.status == null) {
      errors.push(`${label} is missing required field 'status'`);
    } else if (check.status !== "unverified" && check.status !== "verified") {
      errors.push(`${label}.status must be 'unverified' or 'verified'`);
    }
    if (check.status === "unverified" && check.support !== "not-supported") {
      errors.push(
        `${label} is unverified and must be labelled support 'not-supported'`,
      );
    }
    if (check.status === "verified" && (typeof check.liveRunAt !== "string" || !check.liveRunAt)) {
      errors.push(`${label} is verified and must have a dated liveRunAt`);
    }
  }

  for (const id of requiredIds) {
    if (!seen.has(id)) {
      errors.push(`missing launch check '${id}'`);
    }
  }

  return errors;
}

export function lintSpecFile(path = DEFAULT_SPEC_PATH) {
  const spec = JSON.parse(readFileSync(path, "utf8"));
  return lintSpec(spec);
}

export function lintMatrixFile(
  specPath = DEFAULT_SPEC_PATH,
  matrixPath = DEFAULT_MATRIX_PATH,
) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const markdown = readFileSync(matrixPath, "utf8");
  return lintMatrix(spec, markdown);
}

export function lintAzureSpecFiles(
  specPath = DEFAULT_SPEC_PATH,
  matrixPath = DEFAULT_MATRIX_PATH,
) {
  return [...lintSpecFile(specPath), ...lintMatrixFile(specPath, matrixPath)];
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = lintAzureSpecFiles();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log(`azure spec ok: ${REQUIRED_LAUNCH_CHECK_IDS.length} launch checks`);
}
