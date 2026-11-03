#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MANIFEST = join(ROOT, "plugin/.claude-plugin/plugin.json");
const DEFAULT_PACKAGE = join(ROOT, "package.json");

export const PLUGIN_NAME = "farside";
export const PLUGIN_AUTHOR = "Moonaan, LLC";
export const PLUGIN_LICENSE = "UNLICENSED";

export function lintPluginManifest(manifest, productVersion) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["plugin.json must be an object"];
  }
  if (manifest.name !== PLUGIN_NAME) {
    errors.push(`name must be '${PLUGIN_NAME}'`);
  }
  if (!manifest.author || typeof manifest.author !== "object" || Array.isArray(manifest.author)) {
    errors.push("author must be an object");
  } else if (manifest.author.name !== PLUGIN_AUTHOR) {
    errors.push(`author.name must be '${PLUGIN_AUTHOR}'`);
  }
  if (manifest.license !== PLUGIN_LICENSE) {
    errors.push(`license must be '${PLUGIN_LICENSE}'`);
  }
  if (typeof productVersion !== "string" || productVersion.length === 0) {
    errors.push("product version is required");
  } else if (manifest.version !== productVersion) {
    errors.push(`version must match the product version '${productVersion}'`);
  }
  return errors;
}

export function lintPluginManifestFile(
  manifestPath = DEFAULT_MANIFEST,
  packagePath = DEFAULT_PACKAGE,
) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return [`plugin.json is not valid JSON: ${error instanceof Error ? error.message : error}`];
  }
  let product;
  try {
    product = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    return [`package.json is not valid JSON: ${error instanceof Error ? error.message : error}`];
  }
  return lintPluginManifest(manifest, product.version);
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  const errors = lintPluginManifestFile();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log("plugin manifest ok");
}
