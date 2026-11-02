import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_LAUNCH_CHECK_IDS } from "../azure-spec/lint.mjs";
import { lintGroundTruth, lintGroundTruthFile } from "./lint.mjs";
import { applySeed, loadManifest, seedItems, shouldSkipApply } from "./seed.mjs";

describe("azure estate ground truth", () => {
  it("accepts the committed manifest", () => {
    expect(lintGroundTruthFile()).toEqual([]);
  });

  it("covers every Azure launch check", () => {
    const manifest = loadManifest();
    const ids = new Set(manifest.checks.map((check) => check.checkId));
    expect([...REQUIRED_LAUNCH_CHECK_IDS].sort()).toEqual([...ids].sort());
  });

  it("fails when a launch check is missing", () => {
    const manifest = loadManifest();
    manifest.checks = manifest.checks.filter(
      (check) => check.checkId !== "azure-waste-unattached-disks",
    );
    expect(
      lintGroundTruth(manifest).some((error) => error.includes("azure-waste-unattached-disks")),
    ).toBe(true);
  });

  it("fails an exception without a reason", () => {
    const manifest = loadManifest();
    const cost = manifest.checks.find((check) => check.checkId === "azure-cost-reservation-use");
    cost.exception = { status: "unverified", reason: "" };
    const dir = mkdtempSync(join(tmpdir(), "ground-truth-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify(manifest));
    expect(lintGroundTruthFile(path).some((error) => error.includes("exception.reason"))).toBe(
      true,
    );
  });
});

describe("azure estate seed skip", () => {
  it("skips apply when AZURE_SUBSCRIPTION_ID is unset", () => {
    expect(shouldSkipApply({})).toBe(true);
    const result = applySeed({});
    expect(result.applied).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.itemCount).toBe(seedItems(loadManifest()).length);
  });

  it("still skips when a subscription id is present (no live ARM)", () => {
    const result = applySeed({ AZURE_SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000000" });
    expect(result.applied).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/must not call live ARM/);
  });
});
