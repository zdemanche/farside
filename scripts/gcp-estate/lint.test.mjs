import { describe, expect, it } from "vitest";
import { REQUIRED_GCP_TYPES, lintGcpGroundTruth, lintGcpGroundTruthFile } from "./lint.mjs";

describe("gcp estate lint", () => {
  it("accepts the committed GCP ground-truth manifest", () => {
    expect(lintGcpGroundTruthFile()).toEqual([]);
  });

  it("fails when every resource has an owner label", () => {
    const errors = lintGcpGroundTruth({
      cloud: "gcp",
      ownerLabelKey: "owner",
      items: REQUIRED_GCP_TYPES.map((type, index) => ({
        id: `item-${index}`,
        type,
        labels: { owner: "x" },
      })),
    });
    expect(errors.some((error) => error.includes("no owner label"))).toBe(true);
  });

  it("fails when a payload field is present", () => {
    const errors = lintGcpGroundTruth({
      cloud: "gcp",
      ownerLabelKey: "owner",
      items: [{ id: "x", type: "compute.googleapis.com/Disk", labels: {}, payload: true }],
    });
    expect(errors.some((error) => error.includes("payload"))).toBe(true);
  });
});
