import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Finding } from "@farside/scan-contracts";
import {
  CLI_ORG_ID,
  DEFAULT_WORKSPACE_DIRNAME,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  ROLE_LISTING_CLOSER,
  defaultWorkspaceDir,
  readWorkspaceState,
  runCli,
  type ConnectReport,
} from "./cli.js";
import { TOKEN_FLAG_MESSAGE } from "./cli-credentials.js";
import { EXPORT_FORMAT, exportFilename, validateExport } from "./export.js";
import { REPORT_FILENAME, unsourcedReportClaims } from "./report.js";
import { PROVIDER_NOT_CONFIGURED } from "./providers/unconfigured.js";
import { secretPaths } from "./secrets.js";
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
    expect(io.text(io.stderr.chunks)).toContain(TOKEN_FLAG_MESSAGE);
    expect(await runCli(["scan", "--client-secret", "s3cret"], io)).toBe(EXIT_USAGE);
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

  it("keeps each cloud's findings and gives each scan its own id in one workspace", async () => {
    const dir = workspace();
    const io = capture();
    const opts = { ...io, clock: fixedClock };
    expect(
      await runCli(["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir, "--fixture"], opts),
    ).toBe(EXIT_OK);
    const first = JSON.parse(io.text(io.stdout.chunks)) as { scanId: string };
    io.stdout.chunks.length = 0;
    expect(
      await runCli(["scan", "--cloud", "gcp", "--scope", "farside-test", "--workspace", dir, "--fixture"], opts),
    ).toBe(EXIT_OK);
    const second = JSON.parse(io.text(io.stdout.chunks)) as { scanId: string };
    expect(first.scanId).toBe("scan-1");
    expect(second.scanId).toBe("scan-2");
    const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as Finding[];
    expect(findings.some((finding) => finding.checkId === "azure-waste-unattached-disks" && finding.result === "fail")).toBe(
      true,
    );
    expect(findings.some((finding) => finding.checkId === "gcp-waste-unattached-disks" && finding.result === "fail")).toBe(
      true,
    );
    const issues = JSON.parse(readFileSync(join(dir, "issues.json"), "utf8")) as Array<{ cloud: string; status: string }>;
    expect(new Set(issues.filter((issue) => issue.status === "open").map((issue) => issue.cloud))).toEqual(
      new Set(["azure", "gcp"]),
    );
    const coverage = JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8")) as Array<{ checkId: string }>;
    expect(coverage.some((entry) => entry.checkId.startsWith("azure-"))).toBe(true);
    expect(coverage.some((entry) => entry.checkId.startsWith("gcp-"))).toBe(true);
    const state = readWorkspaceState(dir);
    expect(state.scans.map((scan) => [scan.id, scan.cloud])).toEqual([
      ["scan-1", "azure"],
      ["scan-2", "gcp"],
    ]);
    io.stdout.chunks.length = 0;
    expect(await runCli(["export", "--workspace", dir], opts)).toBe(EXIT_OK);
    const exported = JSON.parse(readFileSync(join(dir, exportFilename("inventory")), "utf8")) as {
      rows: Array<{ cloud: string }>;
    };
    expect(new Set(exported.rows.map((row) => row.cloud))).toEqual(new Set(["azure", "gcp"]));
    expect(validateExport(exported)).toEqual([]);
    io.stdout.chunks.length = 0;
    expect(
      await runCli(["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir, "--fixture"], opts),
    ).toBe(EXIT_OK);
    expect((JSON.parse(io.text(io.stdout.chunks)) as { scanId: string }).scanId).toBe("scan-3");
    const rescanned = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as Finding[];
    expect(rescanned.length).toBe(findings.length);
  });

  it("continues scan ids from a workspace written before state.json", async () => {
    const dir = workspace();
    const io = capture();
    const opts = { ...io, clock: fixedClock };
    expect(
      await runCli(["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir, "--fixture"], opts),
    ).toBe(EXIT_OK);
    rmSync(join(dir, "state.json"));
    io.stdout.chunks.length = 0;
    expect(
      await runCli(["scan", "--cloud", "gcp", "--scope", "farside-test", "--workspace", dir, "--fixture"], opts),
    ).toBe(EXIT_OK);
    expect((JSON.parse(io.text(io.stdout.chunks)) as { scanId: string }).scanId).toBe("scan-2");
    const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as Finding[];
    expect(findings.some((finding) => finding.scope.cloud === "azure")).toBe(true);
    expect(findings.some((finding) => finding.scope.cloud === "gcp")).toBe(true);
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
        env: { HOME: dir },
      }),
    ).toBe(EXIT_FAILED);
    expect(io.text(io.stderr.chunks)).toMatch(/Azure CLI|DefaultAzureCredential/);
  });

  it("names missing roles and does not write secrets into the workspace", async () => {
    const dir = workspace();
    const io = capture();
    const secret = "s3cretQ~abcdefghijklmnopqrstuvwxyz0123456789";
    expect(
      await runCli(["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir, "--fixture"], {
        ...io,
        clock: fixedClock,
        env: { AZURE_CLIENT_SECRET: secret },
      }),
    ).toBe(EXIT_OK);
    const dumped = `${readFileSync(join(dir, "findings.json"), "utf8")}${readFileSync(join(dir, "inventory.json"), "utf8")}`;
    expect(dumped).not.toContain(secret);
    expect(secretPaths(JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")))).toEqual([]);
    io.stderr.chunks.length = 0;
    expect(
      await runCli(["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir], {
        ...io,
        clock: fixedClock,
        probe: () => ({ present: true, source: "azure-cli" }),
        grantedRoles: ["Reader"],
      }),
    ).toBe(EXIT_FAILED);
    const report = JSON.parse(io.text(io.stderr.chunks).trim().split("\n")[0] ?? "{}") as {
      missingRoles: Array<{ role: string; required: boolean; blockedCheckIds: string[] }>;
    };
    expect(report.missingRoles.some((gap) => gap.role === "Cost Management Reader" && gap.required)).toBe(true);
    expect(report.missingRoles.find((gap) => gap.role === "Cost Management Reader")?.blockedCheckIds).toContain(
      "azure-cost-spend-by-service",
    );
    expect(io.text(io.stderr.chunks)).toContain(PROVIDER_NOT_CONFIGURED);
  });

  it("connects with fixture credentials and names missing roles", async () => {
    const home = workspace();
    const io = capture();
    expect(
      await runCli(["connect", "--cloud", "azure", "--fixture"], { ...io, env: { HOME: home } }),
    ).toBe(EXIT_OK);
    const dir = defaultWorkspaceDir(home);
    const report = JSON.parse(readFileSync(join(dir, "connect.json"), "utf8")) as ConnectReport;
    expect(report.workspace).toBe(dir);
    expect(dir.endsWith(DEFAULT_WORKSPACE_DIRNAME)).toBe(true);
    expect(report.credentials).toEqual({ present: true, source: "fixture" });
    expect(report.missingRoles).toEqual([]);
    io.stdout.chunks.length = 0;
    expect(
      await runCli(["connect", "--cloud", "azure", "--workspace", home], {
        ...io,
        env: { HOME: home },
        probe: () => ({ present: true, source: "azure-cli" }),
        grantedRoles: ["Reader"],
      }),
    ).toBe(EXIT_FAILED);
    const checked = JSON.parse(io.text(io.stdout.chunks)) as ConnectReport;
    expect(checked.missingRoles.some((gap) => gap.role === "Cost Management Reader" && gap.required)).toBe(true);
    expect(checked.missingRoles.find((gap) => gap.role === "Cost Management Reader")?.blockedCheckIds).toContain(
      "azure-cost-spend-by-service",
    );
    io.stdout.chunks.length = 0;
    expect(
      await runCli(["connect", "--cloud", "gcp"], {
        ...io,
        env: { HOME: home },
        probe: () => ({ present: true, source: "gcp-adc" }),
      }),
    ).toBe(EXIT_OK);
    const unverified = JSON.parse(io.text(io.stdout.chunks)) as ConnectReport;
    expect(unverified.roleListing).toBe("unverified");
    expect(unverified.closer).toBe(ROLE_LISTING_CLOSER);
    expect(unverified.expectedRoles?.some((gap) => gap.role === "Recommender Viewer")).toBe(true);
    expect(unverified.expectedRoles?.find((gap) => gap.role === "Recommender Viewer")?.blockedCheckIds).toContain(
      "gcp-waste-idle-vm-and-disk-recommendations",
    );
  });

  it("writes a consultant report from workspace export rows", async () => {
    const dir = workspace();
    const io = capture();
    const opts = { ...io, clock: fixedClock };
    expect(
      await runCli(["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir, "--fixture"], opts),
    ).toBe(EXIT_OK);
    io.stdout.chunks.length = 0;
    expect(await runCli(["report", "--workspace", dir], opts)).toBe(EXIT_OK);
    const written = JSON.parse(io.text(io.stdout.chunks)) as { report: string };
    expect(written.report).toBe(join(dir, REPORT_FILENAME));
    const html = readFileSync(written.report, "utf8");
    const issues = JSON.parse(readFileSync(join(dir, exportFilename("issues")), "utf8"));
    const cost = JSON.parse(readFileSync(join(dir, exportFilename("cost")), "utf8"));
    expect(unsourcedReportClaims(html, issues, cost)).toEqual([]);
  });

  it("does not import Fastify or the AWS SDK", () => {
    const { files, hits } = walk(ENTRY);
    expect(files).toContain(ENTRY);
    expect(files.some((file) => file.endsWith("app.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith("dynamo-store.ts"))).toBe(false);
    expect(hits).toEqual([]);
  });
});
