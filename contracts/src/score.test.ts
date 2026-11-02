import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scoreHealth } from "./score.js";
import type { Coverage, Finding } from "./types.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;
}

const coverage = load<Coverage>("coverage.with-unassessed.json");
const failing = load<Finding>("finding.valid.json");

describe("health score", () => {
  it("gives coverage only and no score when there are no findings", () => {
    const result = scoreHealth(coverage, []);
    expect(result.coverage).toBe(0.5);
    expect(result.assessedScopes).toBe(1);
    expect(result.unassessedScopes).toBe(1);
    expect(result.score).toBeNull();
  });

  it("ignores unassessed scopes in the score", () => {
    const unassessedFail: Finding = {
      ...failing,
      scope: { ...failing.scope, id: "sub-2:azure-waste-unattached-disks", subscriptionOrProject: "sub-2" },
    };
    const withUnassessedOnly = scoreHealth(coverage, [unassessedFail]);
    expect(withUnassessedOnly.score).toBe(100);

    const withAssessedFail = scoreHealth(coverage, [failing]);
    expect(withAssessedFail.score).toBe(0);
    expect(withAssessedFail.coverage).toBe(0.5);
  });
});
