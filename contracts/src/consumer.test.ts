import { describe, expect, it } from "vitest";

describe("published build", () => {
  it("exports validators and the scoring helper from dist", async () => {
    const published = await import("../dist/index.js");
    expect(published.CONTRACT_VERSION).toBe("farside-scan-contracts@0.1.0");
    expect(typeof published.validateFinding).toBe("function");
    expect(typeof published.validateInventory).toBe("function");
    expect(typeof published.validateCoverage).toBe("function");
    expect(typeof published.scoreHealth).toBe("function");
    expect(published.HEALTH_SCORE_FORMULA).toMatch(/assessed/);
  });
});
