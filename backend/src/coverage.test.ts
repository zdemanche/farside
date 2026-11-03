import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HEALTH_SCORE_FORMULA, scoreHealth, type Finding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import { COVERAGE_CAUSES } from "./causes.js";
import {
  applyCoverageResult,
  blindSpots,
  coverageFromHarvest,
  coverageHealth,
  recordCoverageScope,
  toContractCoverage,
} from "./coverage.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { AZURE_HARVEST_ASSESSED_CHECK_IDS, AZURE_LAUNCH_CHECK_IDS, GCP_LAUNCH_CHECK_IDS } from "./providers/launch-ids.js";
import { secretPaths } from "./secrets.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const LAUNCH = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/launch-checks.json"), "utf8"),
) as { checks: Array<{ id: string }> };

const GCP_LAUNCH = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/gcp/launch-checks.json"), "utf8"),
) as { checks: Array<{ id: string }> };

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

const assessedFail: Finding = {
  checkId: "azure-waste-unattached-disks",
  result: "fail",
  evidence: { fields: { diskId: "disk-unattached", diskState: "Unattached" } },
  scope: {
    id: "main:azure-waste-unattached-disks",
    cloud: "azure",
    subscriptionOrProject: "main",
  },
};

describe("coverage states", () => {
  it("keeps launch check ids aligned with the Azure spec", () => {
    expect([...AZURE_LAUNCH_CHECK_IDS].sort()).toEqual(
      LAUNCH.checks.map((check) => check.id).sort(),
    );
  });

  it("keeps launch check ids aligned with the GCP spec", () => {
    expect([...GCP_LAUNCH_CHECK_IDS].sort()).toEqual(
      GCP_LAUNCH.checks.map((check) => check.id).sort(),
    );
  });

  it("records assessed, unassessed, and undetermined", () => {
    const assessed = recordCoverageScope({
      subscriptionOrProject: "main",
      checkId: "azure-inventory-all-resources",
      state: "assessed",
    });
    const unassessed = recordCoverageScope({
      subscriptionOrProject: "main",
      checkId: "azure-waste-unattached-disks",
      state: "unassessed",
      causeId: "not_run",
    });
    const undetermined = recordCoverageScope({
      subscriptionOrProject: "main",
      checkId: "azure-resilience-prod-vms-outside-backup",
      state: "undetermined",
      causeId: "missing_role",
    });
    expect(assessed.state).toBe("assessed");
    expect(unassessed.state).toBe("unassessed");
    expect(undetermined.state).toBe("undetermined");
    expect(toContractCoverage([assessed, unassessed, undetermined]).scopes.map((scope) => scope.assessed)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("marks inventory checks assessed on harvest and the rest unassessed", () => {
    const entries = coverageFromHarvest(["main"], AZURE_LAUNCH_CHECK_IDS, AZURE_HARVEST_ASSESSED_CHECK_IDS);
    expect(entries).toHaveLength(AZURE_LAUNCH_CHECK_IDS.length);
    expect(
      entries.find((entry) => entry.checkId === "azure-inventory-all-resources")?.state,
    ).toBe("assessed");
    expect(
      entries.find((entry) => entry.checkId === "azure-waste-unattached-disks")?.state,
    ).toBe("unassessed");
  });

  it("maps missing role, throttling, unsupported type, and failed call to plain language", () => {
    expect(COVERAGE_CAUSES.missing_role.reason).toMatch(/missing a required Azure role/);
    expect(COVERAGE_CAUSES.throttling.reason).toMatch(/throttled/);
    expect(COVERAGE_CAUSES.unsupported_type.reason).toMatch(/support matrix/);
    expect(COVERAGE_CAUSES.failed_call.reason).toMatch(/failed before Farside could collect evidence/);
    for (const cause of Object.values(COVERAGE_CAUSES)) {
      expect(cause.reason.length).toBeGreaterThan(20);
      expect(cause.closer.length).toBeGreaterThan(10);
    }
  });

  it("lists undetermined and unassessed rows on Blind spots with a closer", () => {
    const entries = applyCoverageResult(coverageFromHarvest(["main"], AZURE_LAUNCH_CHECK_IDS, AZURE_HARVEST_ASSESSED_CHECK_IDS), {
      subscriptionOrProject: "main",
      checkId: "azure-resilience-prod-vms-outside-backup",
      state: "undetermined",
      causeId: "missing_role",
    });
    const spots = blindSpots(entries);
    const missingRole = spots.find(
      (spot) => spot.checkId === "azure-resilience-prod-vms-outside-backup",
    );
    expect(missingRole?.state).toBe("undetermined");
    expect(missingRole?.reason).toBe(COVERAGE_CAUSES.missing_role.reason);
    expect(missingRole?.closer).toBe(COVERAGE_CAUSES.missing_role.closer);
    expect(spots.every((spot) => spot.closer.length > 0)).toBe(true);
    expect(spots.some((spot) => spot.checkId === "azure-inventory-all-resources")).toBe(false);
  });

  it("uses the contract scoring helper so extra unassessed scopes leave the score unchanged", () => {
    const assessed = recordCoverageScope({
      subscriptionOrProject: "main",
      checkId: "azure-waste-unattached-disks",
      state: "assessed",
    });
    const baseline = coverageHealth([assessed], [assessedFail]);
    expect(baseline.score).toBe(0);
    const withUnassessed = coverageHealth(
      [
        assessed,
        recordCoverageScope({
          subscriptionOrProject: "main",
          checkId: "azure-cost-spend-by-service",
          state: "unassessed",
          causeId: "not_run",
        }),
      ],
      [assessedFail],
    );
    expect(withUnassessed.score).toBe(baseline.score);
    expect(withUnassessed.unassessedScopes).toBe(baseline.unassessedScopes + 1);
    expect(scoreHealth(toContractCoverage([assessed]), [assessedFail]).score).toBe(baseline.score);
    expect(HEALTH_SCORE_FORMULA).toMatch(/assessed/);
  });
});

describe("coverage routes", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, TEST_APP_OPTIONS);

  afterAll(async () => {
    await app.close();
  });

  it("writes harvest coverage when inventory is stored and exposes Blind spots", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: inventoryFromManifest(MANIFEST),
    });
    expect(put.statusCode).toBe(200);

    const overlay = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/coverage",
      headers: ORG,
      payload: {
        subscriptionOrProject: "main",
        checkId: "azure-resilience-prod-vms-outside-backup",
        state: "undetermined",
        causeId: "failed_call",
      },
    });
    expect(overlay.statusCode).toBe(200);
    expect(overlay.json().closer).toBe(COVERAGE_CAUSES.failed_call.closer);

    const spots = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/blind-spots",
      headers: ORG,
    });
    expect(spots.statusCode).toBe(200);
    expect(spots.json().formula).toBe(HEALTH_SCORE_FORMULA);
    expect(secretPaths(spots.json())).toEqual([]);
    const failed = spots.json().spots.find(
      (spot: { checkId: string }) => spot.checkId === "azure-resilience-prod-vms-outside-backup",
    );
    expect(failed.reason).toBe(COVERAGE_CAUSES.failed_call.reason);
    expect(failed.closer).toBe(COVERAGE_CAUSES.failed_call.closer);
  });
});
