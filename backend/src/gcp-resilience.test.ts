import { describe, expect, it } from "vitest";
import { RAW_PROVIDER_KEYS, validateFinding } from "@farside/scan-contracts";
import { factsFromGcpManifest, inventoryFromGcpManifest, type GcpGroundTruthManifest } from "./gcp-inventory.js";
import { checkGcpSqlHaOrBackup, GCP_SQL_HA_OR_BACKUP } from "./gcp-resilience.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/gcp/ground-truth.json"), "utf8"),
) as GcpGroundTruthManifest;

const inventory = inventoryFromGcpManifest(MANIFEST);
const facts = factsFromGcpManifest(MANIFEST);

describe("gcp sql ha and backup check", () => {
  it("fails seeded zonal and no-backup instances and passes regional backed-up ones", () => {
    const findings = checkGcpSqlHaOrBackup(inventory, facts);
    const fails = findings.filter((finding) => finding.result === "fail");
    const passes = findings.filter((finding) => finding.result === "pass");
    expect(fails.map((finding) => finding.evidence.fields.instanceName).sort()).toEqual([
      "sql-no-backup",
      "sql-zonal",
    ]);
    expect(fails.find((finding) => finding.evidence.fields.instanceName === "sql-zonal")).toMatchObject({
      checkId: GCP_SQL_HA_OR_BACKUP,
      evidence: {
        fields: {
          availabilityType: "ZONAL",
          backupEnabled: true,
          projectId: "farside-test",
        },
      },
    });
    expect(fails.find((finding) => finding.evidence.fields.instanceName === "sql-no-backup")?.evidence.fields).toMatchObject(
      {
        availabilityType: "REGIONAL",
        backupEnabled: false,
      },
    );
    expect(passes.map((finding) => finding.evidence.fields.instanceName).sort()).toEqual(["sql-current", "sql-stale"]);
    expect(validateFinding(fails[0]!)).toEqual([]);
    for (const key of RAW_PROVIDER_KEYS) {
      expect(JSON.stringify(findings)).not.toContain(key);
    }
  });

  it("returns undetermined when availabilityType or backupConfiguration is missing", () => {
    const zonal = inventory.resources.find((row) => row.displayName.includes("without regional"));
    expect(zonal).toBeDefined();
    const findings = checkGcpSqlHaOrBackup(inventory, [{ resourceUri: zonal!.resourceUri, fields: {} }]);
    const row = findings.find((finding) => finding.evidence.fields.instanceName === "Cloud SQL without regional high availability");
    expect(row?.result).toBe("undetermined");
    expect(row?.closer).toMatch(/includes both fields/);
  });
});
