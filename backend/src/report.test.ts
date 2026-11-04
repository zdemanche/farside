import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_ORG_ID, runCli } from "./cli.js";
import type { CoverageEntry } from "./coverage.js";
import { EXPORT_FORMAT, exportCost, exportFilename, exportIssues } from "./export.js";
import type { Finding } from "@farside/scan-contracts";
import type { CostSnapshot } from "./cost.js";
import type { StoredIssue } from "./issues.js";
import { buildConsultantReport, extractReportClaims, unsourcedReportClaims } from "./report.js";
import { fixedClock } from "./test-clock.js";

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "farside-report-"));
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

describe("consultant report", () => {
  it("writes HTML whose issue ids, figures and ranges resolve to export rows", async () => {
    const dir = workspace();
    expect(
      await runCli(["scan", "--cloud", "azure", "--scope", "main", "--workspace", dir, "--fixture"], {
        clock: fixedClock,
      }),
    ).toBe(0);
    expect(await runCli(["export", "--workspace", dir], { clock: fixedClock })).toBe(0);
    const issues = JSON.parse(readFileSync(join(dir, "issues.json"), "utf8")) as StoredIssue[];
    const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as Finding[];
    const coverage = JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8")) as CoverageEntry[];
    const cost = JSON.parse(readFileSync(join(dir, "cost.json"), "utf8")) as CostSnapshot;
    const exportedIssues = exportIssues(CLI_ORG_ID, issues, fixedClock());
    const exportedCost = exportCost(CLI_ORG_ID, cost, fixedClock());
    expect(exportedIssues.format).toBe(EXPORT_FORMAT);
    const html = buildConsultantReport({
      issues,
      findings,
      coverage,
      cost,
      exportedIssues,
      exportedCost,
      now: fixedClock(),
    });
    expect(html).toContain("Farside report");
    expect(html).toContain("@media print");
    expect(html).toContain('data-theme="moonaan"');
    expect(html).toContain("--color-text-primary");
    expect(html).toContain("prefers-color-scheme: dark");
    const undetermined = findings.find((finding) => finding.result === "undetermined");
    expect(undetermined?.closer).toBeTruthy();
    expect(html).toContain("undetermined");
    expect(html).toContain(undetermined?.closer ?? "");
    const claims = extractReportClaims(html);
    expect(claims.some((claim) => claim.kind === "issue")).toBe(true);
    expect(claims.some((claim) => claim.kind === "figure")).toBe(true);
    expect(claims.some((claim) => claim.kind === "range")).toBe(true);
    expect(unsourcedReportClaims(html, exportedIssues, exportedCost)).toEqual([]);
    expect(exportedIssues.rows.some((row) => html.includes(`data-issue-id="${row.id}"`))).toBe(true);
    expect(exportFilename("issues")).toBe("farside-issues.json");
  });

  it("fails a claim that is not in the export", () => {
    const html = `<p data-issue-id="missing-issue"></p><p data-figure="monthlyCost" data-amount="99.00"></p>`;
    expect(
      unsourcedReportClaims(
        html,
        exportIssues(CLI_ORG_ID, [], fixedClock()),
        exportCost(CLI_ORG_ID, null, fixedClock()),
      ),
    ).toEqual(["issue missing-issue has no export row", "figure 99.00 has no export row"]);
  });
});
