import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { derive, flattenLiveRun, liveRunRecords, loadRecords, readNotes, regenerate, renderRows, run, writeSpecStatus } from "./generate.mjs";

const spec = () => ({
  checks: [
    { id: "a", group: "waste", title: "A", role: "Reader", status: "unverified", support: "not-supported", liveRunAt: null },
    { id: "b", group: "cost", title: "B", role: "Reader", status: "unverified", support: "not-supported", liveRunAt: null, billingExportRequired: true },
  ],
});

describe("support matrix generator", () => {
  it("marks every check unverified and not supported when there are no run records", () => {
    const { checks, errors } = derive(spec(), []);
    expect(errors).toEqual([]);
    expect(checks.map((c) => [c.status, c.support, c.liveRunAt])).toEqual([
      ["unverified", "not-supported", null],
      ["unverified", "not-supported", null],
    ]);
  });

  it("verifies a check only from a dated passing record, and says the spec disagrees until edited", () => {
    const { checks, errors } = derive(spec(), [{ file: "a.json", checkId: "a", liveRunAt: "2026-12-01", result: "pass" }]);
    expect(checks[0]).toMatchObject({ status: "verified", support: "supported", liveRunAt: "2026-12-01" });
    expect(checks[1]).toMatchObject({ status: "unverified" });
    expect(errors).toEqual([expect.stringContaining("spec 'a' says unverified")]);
  });

  it("does not verify on a failing record", () => {
    const { checks } = derive(spec(), [{ file: "a.json", checkId: "a", liveRunAt: "2026-12-01", result: "fail" }]);
    expect(checks[0]).toMatchObject({ status: "unverified", liveRunAt: null });
  });

  it("uses the latest passing record", () => {
    const { checks } = derive(spec(), [
      { file: "1.json", checkId: "a", liveRunAt: "2026-12-01", result: "pass" },
      { file: "2.json", checkId: "a", liveRunAt: "2026-12-09", result: "pass" },
    ]);
    expect(checks[0].liveRunAt).toBe("2026-12-09");
  });

  it("rejects records for unknown checks, bad dates and bad results", () => {
    const { errors } = derive(spec(), [
      { file: "x.json", checkId: "zzz", liveRunAt: "2026-12-01", result: "pass" },
      { file: "y.json", checkId: "a", liveRunAt: "yesterday", result: "pass" },
      { file: "z.json", checkId: "a", liveRunAt: "2026-12-01", result: "maybe" },
    ]);
    expect(errors).toHaveLength(3);
  });

  it("keeps hand-written Azure notes when regenerating", () => {
    const md = "| Check id | Group | Title | Role | Status | Support | Live run | Notes |\n|---|---|---|---|---|---|---|---|\n| a | waste | A | Reader | unverified | not-supported | — | keep me |\n\nafter";
    expect(readNotes(md).get("a")).toBe("keep me");
    const out = regenerate(md, derive(spec(), []).checks.slice(0, 1), "azure");
    expect(out).toContain("| a | waste | A | Reader | unverified | not-supported | — | keep me |");
    expect(out.endsWith("\n\nafter")).toBe(true);
  });

  it("renders the GCP billing-export column", () => {
    const rows = renderRows(derive(spec(), []).checks, "gcp");
    expect(rows[1]).toBe("| b | cost | B | Reader | yes | unverified | not-supported | — |");
  });

  it("finds the committed Azure and GCP matrices in step with their specs", () => {
    expect(run()).toEqual([]);
  });

  it("flags a stale matrix and rewrites it with --write", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-"));
    for (const dir of ["azure", "gcp"]) {
      mkdirSync(join(root, "docs", dir), { recursive: true });
      for (const file of ["launch-checks.json", "support-matrix.md"]) {
        cpSync(join("docs", dir, file), join(root, "docs", dir, file));
      }
    }
    const matrix = join(root, "docs/gcp/support-matrix.md");
    writeFileSync(matrix, readFileSync(matrix, "utf8").replace("| unverified | not-supported |", "| verified | supported |"));
    expect(run({ root })).toEqual([expect.stringContaining("out of date")]);
    expect(run({ root, write: true })).toEqual([]);
    expect(run({ root })).toEqual([]);
  });
  it("reads GCP live-run records: pass/fail entries count, not-run and role runs do not", () => {
    const root = mkdtempSync(join(tmpdir(), "live-runs-"));
    mkdirSync(join(root, "live-runs"));
    writeFileSync(
      join(root, "live-runs", "2026-12-01-p-checks.json"),
      JSON.stringify({
        liveRunAt: "2026-12-01",
        checks: [
          { checkId: "a", result: "pass" },
          { checkId: "b", result: "not-run" },
        ],
      }),
    );
    writeFileSync(join(root, "live-runs", "2026-12-01-p-roles.json"), JSON.stringify({ liveRunAt: "2026-12-01", roles: [] }));
    const records = loadRecords(root);
    expect(records).toEqual([{ file: "live-runs/2026-12-01-p-checks.json", checkId: "a", liveRunAt: "2026-12-01", result: "pass" }]);
    expect(derive(spec(), records).checks[0]).toMatchObject({ status: "verified", liveRunAt: "2026-12-01" });
    expect(flattenLiveRun("x.json", { liveRunAt: "2026-12-01", checks: [{ checkId: "a", result: "fail" }] })).toHaveLength(1);
  });

  it("flattens live runner records with a checks list and ignores evidence-only records", () => {
    expect(liveRunRecords("2026-12-01-access.json", { kind: "access", liveRunAt: "2026-12-01" })).toEqual([]);
    expect(
      liveRunRecords("2026-12-01-checks-noncost.json", {
        liveRunAt: "2026-12-01",
        checks: [
          { checkId: "a", result: "pass", defects: [] },
          { checkId: "b", result: "fail", defects: ["x"] },
        ],
      }),
    ).toEqual([
      { file: "live-runs/2026-12-01-checks-noncost.json", checkId: "a", liveRunAt: "2026-12-01", result: "pass" },
      { file: "live-runs/2026-12-01-checks-noncost.json", checkId: "b", liveRunAt: "2026-12-01", result: "fail" },
    ]);
  });

  it("regenerates the Azure spec and matrix from a live run record with --write-spec (#125)", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-live-"));
    for (const dir of ["azure", "gcp"]) {
      mkdirSync(join(root, "docs", dir), { recursive: true });
      for (const file of ["launch-checks.json", "support-matrix.md"]) {
        cpSync(join("docs", dir, file), join(root, "docs", dir, file));
      }
    }
    mkdirSync(join(root, "docs/azure/live-runs"));
    writeFileSync(
      join(root, "docs/azure/live-runs/2026-12-01-checks-noncost.json"),
      JSON.stringify({
        kind: "checks-noncost",
        liveRunAt: "2026-12-01",
        checks: [
          { checkId: "azure-waste-unattached-disks", result: "pass", defects: [] },
          { checkId: "azure-waste-old-snapshots", result: "fail", defects: ["snapshot-old: pass (expected fail)"] },
        ],
      }),
    );
    expect(loadRecords(join(root, "docs/azure"))).toHaveLength(2);
    expect(run({ root })).toEqual(
      expect.arrayContaining([expect.stringContaining("spec 'azure-waste-unattached-disks' says unverified")]),
    );
    expect(run({ root, write: true, writeSpec: true })).toEqual([]);
    expect(run({ root })).toEqual([]);
    const spec = JSON.parse(readFileSync(join(root, "docs/azure/launch-checks.json"), "utf8"));
    const byId = Object.fromEntries(spec.checks.map((check) => [check.id, check]));
    expect(byId["azure-waste-unattached-disks"]).toMatchObject({ status: "verified", support: "supported", liveRunAt: "2026-12-01" });
    expect(byId["azure-waste-old-snapshots"]).toMatchObject({ status: "unverified", support: "not-supported", liveRunAt: null });
    expect(readFileSync(join(root, "docs/azure/support-matrix.md"), "utf8")).toContain(
      "| azure-waste-unattached-disks | waste | Unattached disks | Reader | verified | supported | 2026-12-01 |",
    );
  });

  it("edits only status, support and liveRunAt in the spec text", () => {
    const text = [
      "{",
      '  "checks": [',
      "    {",
      '      "id": "a",',
      '      "evidenceFields": ["x", "y"],',
      '      "status": "unverified",',
      '      "support": "not-supported",',
      '      "liveRunAt": null',
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n");
    const next = writeSpecStatus(text, [{ id: "a", status: "verified", support: "supported", liveRunAt: "2026-12-01" }]);
    expect(next).toBe(
      text.replace('"unverified"', '"verified"').replace('"not-supported"', '"supported"').replace("null", '"2026-12-01"'),
    );
    expect(() => writeSpecStatus(text, [{ id: "zzz" }])).toThrow(/no check/);
  });
});
