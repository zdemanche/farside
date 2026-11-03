import { describe, expect, it } from "vitest";
import { RAW_PROVIDER_KEYS, validateFinding } from "@farside/scan-contracts";
import { factsFromGcpManifest, inventoryFromGcpManifest, type GcpGroundTruthManifest } from "./gcp-inventory.js";
import {
  checkGcpSqlGkeSupport,
  GCP_SQL_GKE_SUPPORT,
  loadSupportVersions,
  supportSourceErrors,
} from "./gcp-support.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/gcp/ground-truth.json"), "utf8"),
) as GcpGroundTruthManifest;

const inventory = inventoryFromGcpManifest(MANIFEST);
const facts = factsFromGcpManifest(MANIFEST);

describe("gcp support catalogue", () => {
  it("requires a source on every entry", () => {
    const catalogue = loadSupportVersions();
    expect(supportSourceErrors(catalogue)).toEqual([]);
    expect(catalogue.entries.length).toBeGreaterThan(0);
    for (const entry of catalogue.entries) {
      expect(entry.source.length).toBeGreaterThan(0);
      expect(entry.supportEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("gcp sql and gke support check", () => {
  it("fails out-of-support versions with the date and source, and passes unlisted versions with the catalogue source", () => {
    const findings = checkGcpSqlGkeSupport(inventory, facts);
    const fails = findings.filter((finding) => finding.result === "fail");
    const passes = findings.filter((finding) => finding.result === "pass");
    expect(fails.map((finding) => finding.evidence.fields.resourceName).sort()).toEqual(["gke-stale", "sql-stale"]);
    expect(fails.find((finding) => finding.evidence.fields.resourceName === "sql-stale")).toMatchObject({
      checkId: GCP_SQL_GKE_SUPPORT,
      evidence: {
        fields: {
          resourceKind: "sql",
          version: "MYSQL_5_6",
          supportEnd: "2021-02-01",
          source: "docs/gcp/support-versions.json#MYSQL_5_6",
        },
      },
    });
    expect(fails.find((finding) => finding.evidence.fields.resourceName === "gke-stale")?.evidence.fields.source).toBe(
      "docs/gcp/support-versions.json#gke-1.24",
    );
    expect(passes.map((finding) => finding.evidence.fields.resourceName).sort()).toEqual([
      "gke-current",
      "sql-current",
      "sql-no-backup",
      "sql-zonal",
    ]);
    expect(passes[0]?.evidence.fields.source).toBe("docs/gcp/support-versions.json");
    expect(passes[0]?.evidence.fields.cataloguePublishedAt).toBe("2026-11-03");
    expect(validateFinding(fails[0]!)).toEqual([]);
    for (const key of RAW_PROVIDER_KEYS) {
      expect(JSON.stringify(findings)).not.toContain(key);
    }
  });

  it("returns undetermined when the engine version is missing", () => {
    const stale = inventory.resources.find((row) => row.displayName.includes("out-of-support version"));
    expect(stale).toBeDefined();
    const findings = checkGcpSqlGkeSupport(inventory, [{ resourceUri: stale!.resourceUri, fields: {} }]);
    const undetermined = findings.find((finding) => finding.evidence.fields.resourceName === "sql-stale");
    expect(undetermined?.result).toBe("undetermined");
    expect(undetermined?.closer).toMatch(/engine version/);
  });
});
