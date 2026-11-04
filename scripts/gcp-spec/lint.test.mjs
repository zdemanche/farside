import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_GCP_LAUNCH_CHECK_IDS } from "../reuse-review/lint.mjs";
import { lintGcpMatrix, lintGcpMatrixFile, lintGcpSpec, lintGcpSpecFile } from "./lint.mjs";

function validSpec() {
  return {
    version: 1,
    cloud: "gcp",
    checks: REQUIRED_GCP_LAUNCH_CHECK_IDS.map((id) => ({
      id,
      group: id.includes("cost") ? "cost" : "inventory",
      title: id,
      role: "Compute Viewer",
      dataSource: "test",
      evidenceFields: ["resourceId"],
      savingsBasis: null,
      billingExportRequired: id.includes("cost"),
      undetermined: [{ when: "missing data", closer: "grant a viewer role" }],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null,
    })),
  };
}

describe("gcp spec lint", () => {
  it("accepts the committed launch-checks spec", () => {
    expect(lintGcpSpecFile()).toEqual([]);
  });

  it("fails when a required GCP check is missing", () => {
    const spec = validSpec();
    spec.checks = spec.checks.filter((check) => check.id !== "gcp-cost-spend-by-service");
    expect(lintGcpSpec(spec).some((error) => error.includes("gcp-cost-spend-by-service"))).toBe(true);
  });

  it("fails when a cost check does not require the billing export", () => {
    const spec = validSpec();
    const cost = spec.checks.find((check) => check.id === "gcp-cost-committed-use");
    cost.billingExportRequired = false;
    expect(lintGcpSpec(spec).some((error) => error.includes("billing export"))).toBe(true);
  });

  it("fails a spec file that drops status", () => {
    const spec = validSpec();
    delete spec.checks[0].status;
    const dir = mkdtempSync(join(tmpdir(), "gcp-spec-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify(spec));
    expect(lintGcpSpecFile(path).some((error) => error.includes("status"))).toBe(true);
  });
});

function gcpMatrixMarkdown(rows) {
  const header = [
    "| Check id | Group | Title | Role | Billing export | Status | Support | Live run |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const body = rows.map(
    (row) =>
      `| ${row.id} | ${row.group} | ${row.title} | ${row.role} | ${row.billingExport} | ${row.status} | ${row.support} | ${row.liveRun} |`,
  );
  return [...header, ...body].join("\n");
}

describe("gcp support matrix lint", () => {
  it("accepts the committed support matrix", () => {
    expect(lintGcpMatrixFile()).toEqual([]);
  });

  it("fails when the matrix drops a launch check", () => {
    const spec = validSpec();
    const rows = spec.checks.slice(1).map((check) => ({
      id: check.id,
      group: check.group,
      title: check.title,
      role: check.role,
      billingExport: check.billingExportRequired ? "yes" : "no",
      status: check.status,
      support: check.support,
      liveRun: "—",
    }));
    expect(
      lintGcpMatrix(spec, gcpMatrixMarkdown(rows)).some((error) =>
        error.includes(`support matrix is missing launch check '${spec.checks[0].id}'`),
      ),
    ).toBe(true);
  });

  it("fails when billing export disagrees with the spec", () => {
    const spec = validSpec();
    const rows = spec.checks.map((check) => ({
      id: check.id,
      group: check.group,
      title: check.title,
      role: check.role,
      billingExport: "no",
      status: check.status,
      support: check.support,
      liveRun: "—",
    }));
    expect(
      lintGcpMatrix(spec, gcpMatrixMarkdown(rows)).some((error) =>
        error.includes("billing export 'no' does not match spec 'yes'"),
      ),
    ).toBe(true);
  });
});
