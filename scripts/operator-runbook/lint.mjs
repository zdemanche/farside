#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PATH = join(ROOT, "docs/operator-runbook.md");

export const REQUIRED_STEPS = [
  "record-contract",
  "register-product",
  "create-account",
  "deploy-base",
  "deploy-identity",
  "deploy-launch",
  "deploy-farside",
  "claim-org",
  "connect-azure",
  "first-scan",
];

export function lintRunbook(markdown) {
  const errors = [];
  if (typeof markdown !== "string" || markdown.length === 0) {
    return ["runbook is empty"];
  }
  for (const id of REQUIRED_STEPS) {
    const heading = markdown.match(new RegExp(`^### \\d+\\. .+ \\{#${id}\\}$`, "m"));
    if (!heading) {
      errors.push(`missing step heading {#${id}}`);
      continue;
    }
    const start = markdown.indexOf(heading[0]);
    const rest = markdown.slice(start + heading[0].length);
    const next = rest.search(/^### /m);
    const body = next === -1 ? rest : rest.slice(0, next);
    if (!/^#### Check$/m.test(body)) {
      errors.push(`step ${id} is missing #### Check`);
    }
    if (!/^#### Rollback$/m.test(body)) {
      errors.push(`step ${id} is missing #### Rollback`);
    }
  }
  return errors;
}

export function lintRunbookFile(path = DEFAULT_PATH) {
  return lintRunbook(readFileSync(path, "utf8"));
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = lintRunbookFile();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log(`operator runbook ok: ${REQUIRED_STEPS.length} steps`);
}
