import { describe, expect, it } from "vitest";
import { RAW_PROVIDER_KEYS, validateFinding } from "@farside/scan-contracts";
import { factsFromGcpManifest, inventoryFromGcpManifest, type GcpGroundTruthManifest } from "./gcp-inventory.js";
import { checkGcpExpiringCerts, GCP_EXPIRING_CERTS } from "./gcp-lifecycle.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/gcp/ground-truth.json"), "utf8"),
) as GcpGroundTruthManifest;

const inventory = inventoryFromGcpManifest(MANIFEST);
const facts = factsFromGcpManifest(MANIFEST);

describe("gcp expiring certificates", () => {
  it("fails the seeded certificate inside the warning window and passes the lookalike", () => {
    const findings = checkGcpExpiringCerts(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail).toMatchObject({
      checkId: GCP_EXPIRING_CERTS,
      evidence: {
        fields: {
          certificateId: "cert-expiring",
          expireTime: "2026-11-20T00:00:00Z",
          daysRemaining: 36,
          flagDays: DEFAULT_SETTINGS.certExpiryFlagDays,
        },
      },
    });
    expect(pass?.evidence.fields.certificateId).toBe("cert-current");
    expect(pass?.evidence.fields.daysRemaining).toBe(365);
    expect(validateFinding(fail!)).toEqual([]);
    for (const key of RAW_PROVIDER_KEYS) {
      expect(JSON.stringify(findings)).not.toContain(key);
    }
  });

  it("returns undetermined when expireTime is missing", () => {
    const expiring = inventory.resources.find((row) => row.displayName.includes("warning window"));
    expect(expiring).toBeDefined();
    const findings = checkGcpExpiringCerts(inventory, [{ resourceUri: expiring!.resourceUri, fields: {} }]);
    const row = findings.find((finding) => finding.evidence.fields.certificateId === "Certificate inside the expiry warning window");
    expect(row?.result).toBe("undetermined");
    expect(row?.closer).toMatch(/expireTime/);
  });
});
