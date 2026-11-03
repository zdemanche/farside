import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Finding } from "@farside/scan-contracts";
import {
  CLI_ORG_ID,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  runCli,
} from "./cli.js";
import { EXPORT_FORMAT, exportFilename, validateExport } from "./export.js";
import { PROVIDER_NOT_CONFIGURED } from "./providers/unconfigured.js";
import { fixedClock } from "./test-clock.js";

const ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));
const FORBIDDEN = /^(fastify|@aws-sdk\/)/;
const SPEC =
  /(?:import|export)(?:\s+type)?(?:[\s\S]*?\sfrom\s*|\s+)["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function walk(entry: string): { files: string[]; hits: string[] } {
  const files = new Set<string>();
  const hits: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPEC)) {
      const spec = match[1] ?? match[2];
      if (!spec) {
        continue;
      }
      if (FORBIDDEN.test(spec)) {
        hits.push(`${spec} from ${file}`);
        continue;
      }
      if (!spec.startsWith(".") || spec.endsWith(".json")) {
        continue;
      }
      queue.push(join(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return { files: [...files], hits };
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: { write: (chunk: string) => void stdout.push(chunk), chunks: stdout },
    stderr: { write: (chunk: string) => void stderr.push(chunk), chunks: stderr },
    text: (chunks: string[]) => chunks.join(""),
  };
}

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "farside-cli-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("farside CLI", () => {
  it("exits 2 on a usage error", async () => {
    const io = capture();
    expect(await runCli([], io)).toBe(EXIT_USAGE);
    expect(await runCli(["scan", "--cloud", "azure"], { ...io, clock: fixedClock })).toBe(EXIT_USAGE);
    expect(await runCli(["scan", "--token", "abc"], io)).toBe(EXIT_USAGE);
    expect(io.text(io.stderr.chunks)).toContain("unknown option --token");
  });

  it("scans the Azure fixture estate into a workspace", async () => {
    const dir = workspace();
    const io = capture();
    const code = await runCli(
      ["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir, "--fixture"],
      { ...io, clock: fixedClock },
    );
    expect(code).toBe(EXIT_OK);
    const summary = JSON.parse(io.text(io.stdout.chunks)) as { status: string; coverageSummary: { assessed: number } };
    expect(summary.status).toBe("succeeded");
    expect(summary.coverageSummary.assessed).toBeGreaterThan(0);
    const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as Finding[];
    expect(findings.some((finding) => finding.checkId === "azure-waste-unattached-disks" && finding.result === "fail")).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(join(dir, "inventory.json"), "utf8")).cloud).toBe("azure");
    expect(JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8")).length).toBeGreaterThan(0);
  });

  it("scans the GCP fixture estate", async () => {
    const dir = workspace();
    const io = capture();
    expect(
      await runCli(["scan", "--cloud", "gcp", "--scope", "farside-test", "--workspace", dir, "--fixture"], {
        ...io,
        clock: fixedClock,
      }),
    ).toBe(EXIT_OK);
    const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as Finding[];
    expect(findings.some((finding) => finding.checkId === "gcp-waste-unattached-disks" && finding.result === "fail")).toBe(
      true,
    );
  });

  it("prints workspace findings and writes farside-export/1 files", async () => {
    const dir = workspace();
    const io = capture();
    const opts = { ...io, clock: fixedClock };
    expect(
      await runCli(["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir, "--fixture"], opts),
    ).toBe(EXIT_OK);
    io.stdout.chunks.length = 0;
    expect(await runCli(["findings", "--workspace", dir], opts)).toBe(EXIT_OK);
    const findings = JSON.parse(io.text(io.stdout.chunks)) as Finding[];
    expect(findings.some((finding) => finding.result === "fail")).toBe(true);
    io.stdout.chunks.length = 0;
    expect(await runCli(["export", "--workspace", dir], opts)).toBe(EXIT_OK);
    for (const kind of ["issues", "inventory", "cost"] as const) {
      const envelope = JSON.parse(readFileSync(join(dir, exportFilename(kind)), "utf8")) as {
        format: string;
        orgId: string;
      };
      expect(envelope.format).toBe(EXPORT_FORMAT);
      expect(envelope.orgId).toBe(CLI_ORG_ID);
      expect(validateExport(envelope)).toEqual([]);
    }
  });

  it("fails a live scan without credentials", async () => {
    const dir = workspace();
    const io = capture();
    expect(
      await runCli(["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir], {
        ...io,
        clock: fixedClock,
      }),
    ).toBe(EXIT_FAILED);
    expect(io.text(io.stderr.chunks)).toContain(PROVIDER_NOT_CONFIGURED);
  });

  it("does not import Fastify or the AWS SDK", () => {
    const { files, hits } = walk(ENTRY);
    expect(files).toContain(ENTRY);
    expect(files.some((file) => file.endsWith("app.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith("dynamo-store.ts"))).toBe(false);
    expect(hits).toEqual([]);
  });
});
