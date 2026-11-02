import { describe, expect, it } from "vitest";
import { loadRetiringSkus, retiringSourceErrors } from "./retiring.js";

describe("retiring SKU catalogue", () => {
  it("requires a source on every entry", () => {
    const catalogue = loadRetiringSkus();
    expect(retiringSourceErrors(catalogue)).toEqual([]);
    expect(catalogue.entries.length).toBeGreaterThan(0);
    for (const entry of catalogue.entries) {
      expect(entry.source.length).toBeGreaterThan(0);
      expect(entry.retirementDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
