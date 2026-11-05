import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pluginCliIsCurrent } from "./bundle-cli.mjs";
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

  it("runs a fixture scan from the plugin alone, with no checkout around it", { timeout: 30_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "farside-plugin-only-"));
    dirs.push(home);
    cpSync(join(ROOT, "plugin"), join(home, "plugin"), { recursive: true });
    const workspace = join(home, "workspace");
    const result = spawnSync(
      process.execPath,
      [
        join(home, "plugin/bin/farside.mjs"),
        "scan",
        "--cloud",
        "gcp",
        "--scope",
        "farside-test",
        "--workspace",
        workspace,
        "--fixture",
      ],
      { encoding: "utf8", cwd: home },
    );
    expect(result.status, result.stderr).toBe(0);
    const findings = JSON.parse(readFileSync(join(workspace, "findings.json"), "utf8"));
    expect(findings.some((finding) => finding.result === "fail")).toBe(true);
  });

  it("ships a CLI bundle that matches the current source", { timeout: 30_000 }, async () => {
    expect(await pluginCliIsCurrent()).toBe(true);
  });
});
