#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PATH = join(ROOT, "docs/gcp/ground-truth.json");

export const REQUIRED_GCP_TYPES = [
  "compute.googleapis.com/Disk",
  "compute.googleapis.com/Address",
  "compute.googleapis.com/Snapshot",
  "compute.googleapis.com/Image",
  "compute.googleapis.com/Instance",
];

export function lintGcpGroundTruth(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest must be an object"];
  }
  if (manifest.cloud !== "gcp") {
    errors.push("manifest.cloud must be 'gcp'");
  }
  if (typeof manifest.ownerLabelKey !== "string" || manifest.ownerLabelKey.length === 0) {
    errors.push("ownerLabelKey is required");
  }
  if (!Array.isArray(manifest.items)) {
    return ["manifest.items must be an array", ...errors];
  }
  const types = new Set();
  let unlabeled = 0;
  let labeled = 0;
  for (const [index, item] of manifest.items.entries()) {
    const label = `items[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (item.payload || item.gcpResource || item.armBody) {
      errors.push(`${label} must not hold raw provider payload fields`);
    }
    if (typeof item.type === "string") {
      types.add(item.type);
    }
    const labels = item.labels && typeof item.labels === "object" ? item.labels : {};
    const owner = labels[manifest.ownerLabelKey];
    if (typeof owner === "string" && owner.length > 0) {
      labeled += 1;
    } else {
      unlabeled += 1;
    }
  }
  if (unlabeled < 1) {
    errors.push("manifest must include at least one resource with no owner label");
  }
  if (labeled < 1) {
    errors.push("manifest must include at least one resource with an owner label");
  }
  for (const type of REQUIRED_GCP_TYPES) {
    if (!types.has(type)) {
      errors.push(`seed plan is missing a resource of type '${type}'`);
    }
  }
  return errors;
}

export function lintGcpGroundTruthFile(path = DEFAULT_PATH) {
  return lintGcpGroundTruth(JSON.parse(readFileSync(path, "utf8")));
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = lintGcpGroundTruthFile();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log("gcp estate ground truth ok: owner-label positives and negatives present");
}
