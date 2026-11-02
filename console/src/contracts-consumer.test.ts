import { HEALTH_SCORE_FORMULA, scoreHealth } from "@farside/scan-contracts";
import { describe, expect, it } from "vitest";

describe("scan-contracts consumer (console)", () => {
  it("imports the scoring helper and does not reimplement it", () => {
    expect(HEALTH_SCORE_FORMULA).toMatch(/assessed/);
    const result = scoreHealth({ scopes: [] }, []);
    expect(result.score).toBeNull();
    expect(result.coverage).toBe(0);
  });
});
