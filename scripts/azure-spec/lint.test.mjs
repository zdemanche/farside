import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_LAUNCH_CHECK_IDS,
  lintMatrix,
  lintMatrixFile,
  lintSpec,
  lintSpecFile,
  lintUntestedAgreementTypes,
} from "./lint.mjs";

function validSpec(overrides = {}) {
  return {
    version: 1,
    statusAsOf: "2026-11-04",
    checks: REQUIRED_LAUNCH_CHECK_IDS.map((id) => ({
      id,
      group: "inventory",
      title: id,
      role: "Reader",
      dataSource: "test",
      evidenceFields: ["resourceId"],
      savingsBasis: null,
      undetermined: [{ when: "missing data", closer: "grant Reader" }],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null,
      ...overrides,
    })),
  };
}

describe("azure spec lint", () => {
  it("accepts the committed launch-checks spec", () => {
    expect(lintSpecFile()).toEqual([]);
  });

  it("fails when a required field is missing", () => {
    const spec = validSpec();
    delete spec.checks[0].role;
    expect(lintSpec(spec).some((error) => error.includes("missing required field 'role'"))).toBe(
      true,
    );
  });

  it("fails when statusAsOf is missing", () => {
    const spec = validSpec();
    delete spec.statusAsOf;
    expect(lintSpec(spec).some((error) => error.includes("statusAsOf"))).toBe(true);
  });

  it("does not require statusAsOf on a GCP spec", () => {
    expect(lintSpec({ cloud: "gcp", checks: [] }, []).some((error) => error.includes("statusAsOf"))).toBe(
      false,
    );
  });

  it("fails when status is missing", () => {
    const spec = validSpec();
    delete spec.checks[3].status;
    expect(lintSpec(spec).some((error) => error.includes("missing required field 'status'"))).toBe(
      true,
    );
  });

  it("fails when an unverified entry is not labelled not-supported", () => {
    const spec = validSpec();
    spec.checks[0].support = "supported";
    expect(
      lintSpec(spec).some((error) => error.includes("must be labelled support 'not-supported'")),
    ).toBe(true);
  });

  it("fails a spec file that drops a required field", () => {
    const spec = validSpec();
    delete spec.checks[1].dataSource;
    const dir = mkdtempSync(join(tmpdir(), "azure-spec-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify(spec));
    expect(lintSpecFile(path).some((error) => error.includes("dataSource"))).toBe(true);
  });
});

function matrixMarkdown(rows) {
  const header = [
    "| Check id | Group | Title | Role | Status | Support | Live run | Notes |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const body = rows.map(
    (row) =>
      `| ${row.id} | ${row.group} | ${row.title} | ${row.role} | ${row.status} | ${row.support} | ${row.liveRun} | |`,
  );
  return [...header, ...body].join("\n");
}

function matchingMatrix(spec) {
  return matrixMarkdown(
    spec.checks.map((check) => ({
      id: check.id,
      group: check.group,
      title: check.title,
      role: check.role,
      status: check.status,
      support: check.support,
      liveRun: check.liveRunAt ?? "—",
    })),
  );
}

describe("azure support matrix lint", () => {
  it("accepts the committed support matrix", () => {
    expect(lintMatrixFile()).toEqual([]);
  });

  it("accepts a matrix that matches the spec", () => {
    expect(lintMatrix(validSpec(), matchingMatrix(validSpec()))).toEqual([]);
  });

  it("fails when the matrix drops a launch check", () => {
    const spec = validSpec();
    const rows = spec.checks.slice(1).map((check) => ({
      id: check.id,
      group: check.group,
      title: check.title,
      role: check.role,
      status: check.status,
      support: check.support,
      liveRun: "—",
    }));
    expect(
      lintMatrix(spec, matrixMarkdown(rows)).some((error) =>
        error.includes(`support matrix is missing launch check '${spec.checks[0].id}'`),
      ),
    ).toBe(true);
  });

  it("fails when status disagrees with the spec", () => {
    const spec = validSpec();
    const markdown = matchingMatrix(spec).replace("| unverified |", "| verified |");
    expect(
      lintMatrix(spec, markdown).some((error) => error.includes("status 'verified' does not match spec")),
    ).toBe(true);
  });

  it("fails when live run disagrees with the spec", () => {
    const spec = validSpec();
    spec.checks[0].liveRunAt = "2026-11-04";
    expect(
      lintMatrix(spec, matchingMatrix({ ...spec, checks: [{ ...spec.checks[0], liveRunAt: null }, ...spec.checks.slice(1)] })).some(
        (error) => error.includes("live run '—' does not match spec '2026-11-04'"),
      ),
    ).toBe(true);
  });

  it("fails when the matrix has an unknown check", () => {
    const spec = validSpec();
    const extra = matchingMatrix(spec) + "\n| not-a-launch-check | inventory | Extra | Reader | unverified | not-supported | — | |";
    expect(lintMatrix(spec, extra).some((error) => error.includes("unknown check 'not-a-launch-check'"))).toBe(
      true,
    );
  });
});

describe("untested agreement types", () => {
  it("accepts the committed support matrix", () => {
    expect(lintUntestedAgreementTypes(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/support-matrix.md"), "utf8"))).toEqual(
      [],
    );
  });

  it("fails when an agreement type is missing", () => {
    expect(
      lintUntestedAgreementTypes("## Untested agreement types\nPay-as-you-go untested").some((error) =>
        error.includes("Microsoft Customer Agreement"),
      ),
    ).toBe(true);
  });
});
