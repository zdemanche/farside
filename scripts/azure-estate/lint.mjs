#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REQUIRED_LAUNCH_CHECK_IDS } from "../azure-spec/lint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MANIFEST_PATH = join(ROOT, "docs/azure/ground-truth.json");

const T2_REQUIRED_TYPES = [
  "Microsoft.Compute/disks",
  "Microsoft.Network/publicIPAddresses",
  "Microsoft.Compute/snapshots",
  "Microsoft.Compute/virtualMachines",
  "Microsoft.Web/serverfarms",
  "Microsoft.Network/loadBalancers",
  "Microsoft.Network/natGateways",
  "Microsoft.Sql/servers/databases",
  "Microsoft.Network/applicationGateways",
];

export function lintGroundTruth(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest must be an object"];
  }
  if (!Array.isArray(manifest.items)) {
    return ["manifest.items must be an array"];
  }
  if (!Array.isArray(manifest.checks)) {
    return ["manifest.checks must be an array"];
  }
  if (!Array.isArray(manifest.subscriptions) || manifest.subscriptions.length < 2) {
    errors.push("manifest.subscriptions must list the main seeded sub and the empty no-budget sub");
  } else {
    const ids = new Set(manifest.subscriptions.map((sub) => sub && sub.id));
    if (!ids.has("main") || !ids.has("empty-no-budget")) {
      errors.push("subscriptions must include 'main' and 'empty-no-budget'");
    }
    const empty = manifest.subscriptions.find((sub) => sub && sub.id === "empty-no-budget");
    if (empty && empty.budget && empty.budget.present !== false) {
      errors.push("empty-no-budget must have budget.present false");
    }
    const main = manifest.subscriptions.find((sub) => sub && sub.id === "main");
    if (main && (!main.budget || main.budget.present !== true || main.budget.alert !== true)) {
      errors.push("main must have a budget with an alert");
    }
  }

  const itemIds = new Set();
  const types = new Set();
  for (const [index, item] of manifest.items.entries()) {
    const label = `items[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      errors.push(`${label}.id must be a non-empty string`);
    } else if (itemIds.has(item.id)) {
      errors.push(`duplicate item id '${item.id}'`);
    } else {
      itemIds.add(item.id);
    }
    if (typeof item.type === "string") {
      types.add(item.type);
    }
    if (item.subscription !== "main" && item.subscription !== "empty-no-budget") {
      errors.push(`${label}.subscription must be main or empty-no-budget`);
    }
  }

  for (const type of T2_REQUIRED_TYPES) {
    if (!types.has(type)) {
      errors.push(`seed plan is missing a resource of type '${type}'`);
    }
  }

  const seenChecks = new Set();
  for (const [index, check] of manifest.checks.entries()) {
    const label = `checks[${index}]`;
    if (!check || typeof check !== "object") {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof check.checkId !== "string" || check.checkId.length === 0) {
      errors.push(`${label}.checkId must be a non-empty string`);
      continue;
    }
    if (seenChecks.has(check.checkId)) {
      errors.push(`duplicate checkId '${check.checkId}'`);
    } else {
      seenChecks.add(check.checkId);
    }
    const positives = Array.isArray(check.positives) ? check.positives : null;
    const negatives = Array.isArray(check.negatives) ? check.negatives : null;
    if (!positives || !negatives) {
      errors.push(`${label} must have positives and negatives arrays`);
      continue;
    }
    for (const id of [...positives, ...negatives]) {
      if (!itemIds.has(id)) {
        errors.push(`${label} references unknown item '${id}'`);
      }
    }
    const exception = check.exception;
    if (exception != null) {
      if (typeof exception !== "object" || typeof exception.reason !== "string" || !exception.reason) {
        errors.push(`${label}.exception.reason must be a non-empty string`);
      }
      if (!exception.status || exception.status !== "unverified") {
        errors.push(`${label}.exception.status must be 'unverified'`);
      }
      continue;
    }
    const hasEmptySub = typeof check.emptySubscriptionId === "string";
    if (positives.length === 0 && !hasEmptySub) {
      errors.push(`${label} needs a positive item or an exception`);
    }
    if (negatives.length === 0 && !hasEmptySub) {
      errors.push(`${label} needs a negative item or an exception`);
    }
  }

  for (const id of REQUIRED_LAUNCH_CHECK_IDS) {
    if (!seenChecks.has(id)) {
      errors.push(`missing launch check '${id}' in the ground-truth manifest`);
    }
  }

  return errors;
}

export function lintGroundTruthFile(path = DEFAULT_MANIFEST_PATH) {
  return lintGroundTruth(JSON.parse(readFileSync(path, "utf8")));
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = lintGroundTruthFile();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log(
    `azure estate ground truth ok: ${REQUIRED_LAUNCH_CHECK_IDS.length} launch checks mapped`,
  );
}
