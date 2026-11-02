import { describe, expect, it } from "vitest";
import { FARSIDE_IAC_HUB_PRODUCT } from "./products-entry.js";

describe("iac-hub PRODUCTS proposal", () => {
  it("registers key farside with the Identity three-stage shape", () => {
    expect(FARSIDE_IAC_HUB_PRODUCT.key).toBe("Farside");
    expect(FARSIDE_IAC_HUB_PRODUCT.deploymentKey).toBe("farside");
    expect(FARSIDE_IAC_HUB_PRODUCT.stages.map((stage) => stage.key)).toEqual([
      "BackendArtifacts",
      "Infra",
      "Web",
    ]);
    expect(FARSIDE_IAC_HUB_PRODUCT.stages.every((stage) => stage.targetRepo === "moonaan-farside")).toBe(
      true,
    );
    expect(FARSIDE_IAC_HUB_PRODUCT.stages.every((stage) => stage.manifest === true)).toBe(true);
  });
});
