import { CONTRACT_VERSION, validateFinding } from "@farside/scan-contracts";
import { describe, expect, it } from "vitest";

describe("scan-contracts consumer (backend)", () => {
  it("imports validators from the published workspace package", () => {
    expect(CONTRACT_VERSION).toBe("farside-scan-contracts@0.1.0");
    expect(
      validateFinding({
        checkId: "azure-waste-unattached-disks",
        result: "pass",
        evidence: { fields: { ok: true } },
        scope: { id: "sub-1:check", cloud: "azure", subscriptionOrProject: "sub-1" },
      }),
    ).toEqual([]);
  });
});
