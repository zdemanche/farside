import { describe, expect, it } from "vitest";
import { RAW_PROVIDER_KEYS, validateFinding } from "@farside/scan-contracts";
import {
  checkGcpCommittedUse,
  checkGcpCud,
  CUD_EXPORT_CLOSER,
  fixtureCudHarvest,
  GCP_COMMITTED_USE,
} from "./gcp-commitments.js";
import { factsFromGcpManifest, inventoryFromGcpManifest, type GcpGroundTruthManifest } from "./gcp-inventory.js";
import { GCP_CUD_SAVINGS_BASIS } from "./savings.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/gcp/ground-truth.json"), "utf8"),
) as GcpGroundTruthManifest;

describe("gcp committed-use discount", () => {
  it("fails low utilisation with an unused-spend range and passes a well-used commitment", () => {
    const { findings, coverage } = checkGcpCommittedUse("farside-test", fixtureCudHarvest());
    const low = findings.find((finding) => finding.evidence.fields.commitmentName === "cud-low");
    const used = findings.find((finding) => finding.evidence.fields.commitmentName === "cud-used");
    expect(low?.checkId).toBe(GCP_COMMITTED_USE);
    expect(low?.result).toBe("fail");
    expect(low?.savings).toEqual({ min: "48.00", max: "72.00", currency: "USD" });
    expect(low?.evidence.fields.savingsBasis).toBe(GCP_CUD_SAVINGS_BASIS);
    expect(used?.result).toBe("pass");
    expect(used?.savings).toBeUndefined();
    expect(coverage[0]?.state).toBe("assessed");
    expect(validateFinding(low!)).toEqual([]);
  });

  it("says none were found instead of zero utilisation", () => {
    const { findings } = checkGcpCommittedUse("farside-test", { ok: true, commitments: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.result).toBe("pass");
    expect(findings[0]?.evidence.fields.noneFound).toBe(true);
    expect(findings[0]?.evidence.fields.utilizationPercent).toBeUndefined();
    expect(JSON.stringify(findings)).not.toMatch(/"utilizationPercent":0/);
  });

  it("is undetermined when the billing export is missing", () => {
    const { findings, coverage } = checkGcpCommittedUse("farside-test", { ok: false, missingExport: true });
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toBe(CUD_EXPORT_CLOSER);
    expect(coverage[0]).toMatchObject({ state: "unassessed", closer: CUD_EXPORT_CLOSER });
  });

  it("runs the fixture harvest from inventory", () => {
    const findings = checkGcpCud(inventoryFromGcpManifest(MANIFEST), factsFromGcpManifest(MANIFEST));
    expect(findings.some((finding) => finding.evidence.fields.commitmentName === "cud-low" && finding.result === "fail")).toBe(
      true,
    );
    for (const key of RAW_PROVIDER_KEYS) {
      expect(JSON.stringify(findings)).not.toContain(key);
    }
  });
});
