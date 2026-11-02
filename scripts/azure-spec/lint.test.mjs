import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_LAUNCH_CHECK_IDS,
  lintSpec,
  lintSpecFile,
} from "./lint.mjs";

function validSpec(overrides = {}) {
  return {
    version: 1,
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
