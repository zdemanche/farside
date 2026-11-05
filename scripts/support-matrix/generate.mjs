#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Farside-local run record: docs/<cloud>/run-records/*.json, one object per file:
// { "checkId": "...", "liveRunAt": "YYYY-MM-DD", "result": "pass" | "fail" }
export const CLOUDS = {
  azure: { dir: "docs/azure", billingColumn: false },
  gcp: { dir: "docs/gcp", billingColumn: true },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function loadRecords(dir) {
  const folder = join(dir, "run-records");
  if (!existsSync(folder)) {
    return [];
  }
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ file: name, ...JSON.parse(readFileSync(join(folder, name), "utf8")) }));
}

/** A check is verified only by a dated passing record; the latest passing record wins. */
export function derive(spec, records) {
  const errors = [];
  const ids = new Set(spec.checks.map((check) => check.id));
  const passing = new Map();
  for (const record of records) {
    if (!ids.has(record.checkId)) {
      errors.push(`run record ${record.file} names unknown check '${record.checkId}'`);
      continue;
    }
    if (typeof record.liveRunAt !== "string" || !DATE.test(record.liveRunAt)) {
      errors.push(`run record ${record.file} needs a liveRunAt date (YYYY-MM-DD)`);
      continue;
    }
    if (record.result !== "pass" && record.result !== "fail") {
      errors.push(`run record ${record.file} result must be 'pass' or 'fail'`);
      continue;
    }
    if (record.result === "pass") {
      const seen = passing.get(record.checkId);
      if (!seen || record.liveRunAt > seen) {
        passing.set(record.checkId, record.liveRunAt);
      }
    }
  }
  const checks = spec.checks.map((check) => {
    const liveRunAt = passing.get(check.id) ?? null;
    return {
      ...check,
      status: liveRunAt ? "verified" : "unverified",
      support: liveRunAt ? "supported" : "not-supported",
      liveRunAt,
    };
  });
  for (const [index, check] of spec.checks.entries()) {
    const wanted = checks[index];
    if (
      check.status !== wanted.status ||
      check.support !== wanted.support ||
      (check.liveRunAt ?? null) !== wanted.liveRunAt
    ) {
      errors.push(
        `spec '${check.id}' says ${check.status}/${check.support}/${check.liveRunAt ?? "none"} but run records give ${wanted.status}/${wanted.support}/${wanted.liveRunAt ?? "none"}`,
      );
    }
  }
  return { checks, errors };
}

function row(cells) {
  return `| ${cells.join(" | ")} |`;
}

export function renderRows(checks, cloud, notes = new Map()) {
  return checks.map((check) => {
    const live = check.liveRunAt ?? "—";
    return CLOUDS[cloud].billingColumn
      ? row([
          check.id,
          check.group,
          check.title,
          check.role,
          check.billingExportRequired ? "yes" : "no",
          check.status,
          check.support,
          live,
        ])
      : `${row([
          check.id,
          check.group,
          check.title,
          check.role,
          check.status,
          check.support,
          live,
        ])} ${notes.get(check.id) ? `${notes.get(check.id)} |` : "|"}`;
  });
}

/** Notes are hand-written per row (Azure only); keep them across regeneration. */
export function readNotes(markdown) {
  const notes = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 8 && cells[0] && cells[0] !== "Check id" && !/^-+$/.test(cells[0])) {
      notes.set(cells[0], cells[7]);
    }
  }
  return notes;
}

export function regenerate(markdown, checks, cloud) {
  const lines = markdown.split(/\r?\n/);
  const head = lines.findIndex((line) => line.startsWith("| Check id"));
  if (head === -1) {
    throw new Error("support matrix has no table header");
  }
  const first = head + 2;
  let last = first;
  while (last < lines.length && lines[last].startsWith("|")) {
    last += 1;
  }
  const rows = renderRows(checks, cloud, readNotes(markdown));
  return [...lines.slice(0, first), ...rows, ...lines.slice(last)].join("\n");
}

export function run({ write = false, root = ROOT } = {}) {
  const errors = [];
  for (const [cloud, { dir }] of Object.entries(CLOUDS)) {
    const specPath = join(root, dir, "launch-checks.json");
    const matrixPath = join(root, dir, "support-matrix.md");
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    const { checks, errors: problems } = derive(spec, loadRecords(join(root, dir)));
    errors.push(...problems.map((message) => `${cloud}: ${message}`));
    const current = readFileSync(matrixPath, "utf8");
    const next = regenerate(current, checks, cloud);
    if (next !== current) {
      if (write) {
        writeFileSync(matrixPath, next);
      } else {
        errors.push(`${cloud}: ${dir}/support-matrix.md is out of date; run with --write`);
      }
    }
  }
  return errors;
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = run({ write: process.argv.includes("--write") });
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log("support matrices match the spec and run records");
}
