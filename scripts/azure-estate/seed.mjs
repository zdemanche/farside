#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MANIFEST_PATH = join(ROOT, "docs/azure/ground-truth.json");

export function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function seedItems(manifest) {
  return (manifest.items ?? []).filter((item) => item.subscription === "main");
}

/**
 * ARM apply needs a real subscription in a tenant other than the app
 * registration. Missing that identity is a skip, not a CI failure.
 */
export function shouldSkipApply(env = process.env) {
  return !env.AZURE_SUBSCRIPTION_ID;
}

export function applySeed(env = process.env, manifest = loadManifest()) {
  const items = seedItems(manifest);
  if (shouldSkipApply(env)) {
    return {
      applied: false,
      skipped: true,
      reason: "AZURE_SUBSCRIPTION_ID is not set. Physical provision is E1-S5-T1/T2 leftover.",
      itemCount: items.length,
    };
  }
  return {
    applied: false,
    skipped: true,
    reason:
      "AZURE_SUBSCRIPTION_ID is set, but this workspace must not call live ARM. Apply stays skipped until E1-S5-T1 exists.",
    itemCount: items.length,
  };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const result = applySeed();
  console.log(result.reason);
  console.log(`seed plan items: ${result.itemCount}`);
  process.exit(0);
}
