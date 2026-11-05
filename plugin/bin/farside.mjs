#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pluginRoot, "..");
// A marketplace install has only plugin/, so the CLI is bundled inside it.
const shipped = join(pluginRoot, "bin/farside-cli.mjs");
const bundled = join(repoRoot, "backend/dist/farside-cli.mjs");
const source = join(repoRoot, "backend/src/cli.ts");
const tsx = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const args = process.argv.slice(2);

const built = [shipped, bundled].find((path) => existsSync(path));
const result = built
  ? spawnSync(process.execPath, [built, ...args], { stdio: "inherit" })
  : spawnSync(process.execPath, [tsx, source, ...args], { stdio: "inherit", cwd: repoRoot });

process.exit(result.status ?? 1);
