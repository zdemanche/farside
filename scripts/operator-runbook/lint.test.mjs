import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_STEPS, lintRunbook, lintRunbookFile } from "./lint.mjs";

function validRunbook() {
  return REQUIRED_STEPS.map(
    (id, index) => `### ${index + 1}. ${id} {#${id}}\n\n#### Check\n\n- ok\n\n#### Rollback\n\n- retry\n`,
  ).join("\n");
}

describe("operator runbook lint", () => {
  it("accepts the committed runbook", () => {
    expect(lintRunbookFile()).toEqual([]);
  });

  it("fails when a required step is missing", () => {
    const markdown = validRunbook().replace("### 10. first-scan {#first-scan}", "### 10. other {#other}");
    expect(lintRunbook(markdown).some((error) => error.includes("first-scan"))).toBe(true);
  });

  it("fails when Check or Rollback is missing", () => {
    const markdown = validRunbook().replace("#### Rollback\n\n- retry\n", "");
    expect(lintRunbook(markdown).some((error) => error.includes("Rollback"))).toBe(true);
  });

  it("fails a file that drops a step", () => {
    const dir = mkdtempSync(join(tmpdir(), "operator-runbook-"));
    const path = join(dir, "bad.md");
    writeFileSync(path, "# empty\n");
    expect(lintRunbookFile(path).length).toBe(REQUIRED_STEPS.length);
  });
});
