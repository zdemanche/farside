import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_GCP_LAUNCH_CHECK_IDS } from "../reuse-review/lint.mjs";
import { lintGcpSpec, lintGcpSpecFile } from "./lint.mjs";

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
