import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { lintPluginCommands } from "./lint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WRAPPER = join(ROOT, "plugin/bin/farside.mjs");
const SCAN_COMMAND = join(ROOT, "plugin/commands/scan.md");

const dirs = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("plugin command path", () => {
  it("validates command frontmatter", () => {
    expect(lintPluginCommands()).toEqual([]);
  });

  it("runs a fixture scan through the plugin CLI wrapper", { timeout: 30_000 }, () => {
    const scan = readFileSync(SCAN_COMMAND, "utf8");
    expect(scan).toContain("bin/farside.mjs scan");
    const dir = mkdtempSync(join(tmpdir(), "farside-plugin-scan-"));
    dirs.push(dir);
    const result = spawnSync(
      process.execPath,
      [WRAPPER, "scan", "--cloud", "azure", "--scope", "main", "--workspace", dir, "--fixture"],
      { encoding: "utf8", cwd: ROOT },
    );
    expect(result.status, result.stderr).toBe(0);
    const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    expect(findings.some((finding) => finding.result === "fail")).toBe(true);
  });
});
