import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateCoverage, validateFinding, validateInventory } from "./validate.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

describe("finding contract", () => {
  it("accepts a valid finding", () => {
    expect(validateFinding(load("finding.valid.json"))).toEqual([]);
  });

  it("rejects a finding without evidence", () => {
    const errors = validateFinding(load("finding.no-evidence.json"));
    expect(errors.some((error) => error.message.includes("without evidence"))).toBe(true);
  });

  it("rejects undetermined without a closer", () => {
    const errors = validateFinding(load("finding.undetermined-no-closer.json"));
    expect(errors.some((error) => error.path === "closer")).toBe(true);
  });

  it("accepts undetermined with a closer", () => {
    expect(validateFinding(load("finding.undetermined.valid.json"))).toEqual([]);
  });

  it("rejects a single point savings value", () => {
    const errors = validateFinding(load("finding.point-savings.json"));
    expect(errors.some((error) => error.message.includes("point value"))).toBe(true);
  });

  it("rejects raw provider payload fields", () => {
    const errors = validateFinding(load("finding.raw-payload.json"));
    expect(errors.some((error) => error.message.includes("raw provider payload"))).toBe(true);
  });
});

describe("inventory and coverage contracts", () => {
  it("accepts aggregate inventory", () => {
    expect(validateInventory(load("inventory.valid.json"))).toEqual([]);
  });

  it("rejects inventory that embeds a provider payload", () => {
    const inventory = load("inventory.valid.json") as { resources: Record<string, unknown>[] };
    const first = inventory.resources[0];
    if (first) {
      first.sdkResponse = { raw: true };
    }
    expect(validateInventory(inventory).some((error) => error.message.includes("raw provider"))).toBe(
      true,
    );
  });

  it("accepts coverage with an unassessed scope", () => {
    expect(validateCoverage(load("coverage.with-unassessed.json"))).toEqual([]);
  });
});
