#!/usr/bin/env node
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundle } from "../../backend/bundle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const PLUGIN_CLI = join(ROOT, "plugin/bin/farside-cli.mjs");

/** Builds the CLI the way the backend does and returns the bytes of the single-file bundle. */
export async function buildCli() {
  const dir = mkdtempSync(join(tmpdir(), "farside-cli-"));
  try {
    await bundle(dir);
    return readFileSync(join(dir, "farside-cli.mjs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when the committed plugin CLI is exactly what the current source builds. */
export async function pluginCliIsCurrent(path = PLUGIN_CLI) {
  try {
    return (await buildCli()).equals(readFileSync(path));
  } catch {
    return false;
  }
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  if (process.argv.includes("--write")) {
    const dir = mkdtempSync(join(tmpdir(), "farside-cli-"));
    await bundle(dir);
    copyFileSync(join(dir, "farside-cli.mjs"), PLUGIN_CLI);
    rmSync(dir, { recursive: true, force: true });
    console.log("plugin/bin/farside-cli.mjs rebuilt");
  } else if (await pluginCliIsCurrent()) {
    console.log("plugin CLI bundle is current");
  } else {
    console.error("plugin/bin/farside-cli.mjs is out of date; run npm run plugin:bundle");
    process.exit(1);
  }
}
