import { describe, expect, it } from "vitest";
import type { Inventory } from "@farside/scan-contracts";
import { diffCheck, diffInventory, type ManifestWithChecks } from "./ground-truth-diff.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };

const MANIFEST = docAzureGroundTruth as unknown as ManifestWithChecks;
const SUBS = { main: "sub-main", "empty-no-budget": "sub-empty" };
const check = (id: string) => MANIFEST.checks.find((item) => item.checkId === id)!;

function inventoryOf(names: string[], owner: (name: string) => string | null = () => "farside-test"): Inventory {
  return {
    cloud: "azure",
    observedAt: "2026-11-02T00:00:00.000Z",
    resources: names.map((name) => ({
      resourceUri: `/subscriptions/sub-main/resourceGroups/rg/providers/x/${name}`,
      resourceType: MANIFEST.items.find((item) => item.id === name)?.type ?? "Microsoft.Compute/disks",
      region: "eastus",
      displayName: name,
      tags: {},
      ownerTag: owner(name),
    })),
  };
}

const LAUNCH_ITEMS = MANIFEST.items.filter((item) => item.type !== "Microsoft.Consumption/budgets").map((item) => item.id);

describe("ground truth diff", () => {
  it("passes an inventory that matches the manifest", () => {
    const owner = (name: string) => MANIFEST.items.find((item) => item.id === name)?.tags.owner ?? null;
    expect(diffInventory(MANIFEST, inventoryOf(LAUNCH_ITEMS, owner), SUBS)).toMatchObject({ result: "pass", missing: [], unexpected: [] });
  });

  it("names missing, unexpected and wrongly tagged resources", () => {
    const names = [...LAUNCH_ITEMS.filter((name) => name !== "disk-attached"), "stray-vm"];
    const diff = diffInventory(MANIFEST, inventoryOf(names, () => "farside-test"), SUBS);
    expect(diff.result).toBe("fail");
    expect(diff.missing).toEqual(["disk-attached"]);
    expect(diff.unexpected).toEqual(["stray-vm"]);
    expect(diff.ownerMismatch).toEqual(["disk-unattached: owner farside-test (expected none)"]);
  });

  it("skips exceptions and checks whose empty subscription was not run", () => {
    const scan = { findings: [], coverage: [], inventory: inventoryOf([]) };
    expect(diffCheck(check("azure-cost-reservation-use"), MANIFEST, scan, SUBS)).toMatchObject({ skipped: expect.stringContaining("unverified") });
    expect(diffCheck(check("azure-inventory-all-resources"), MANIFEST, scan, { main: "sub-main" })).toMatchObject({
      skipped: "subscription 'empty-no-budget' was not part of the run",
    });
  });

  it("fails a check whose positive did not fail or whose negative did not pass", () => {
    const finding = (name: string, result: "pass" | "fail" | "undetermined") => ({
      checkId: "azure-waste-unattached-disks",
      result,
      evidence: { fields: { resourceUri: `/subscriptions/sub-main/x/${name}` } },
      scope: { id: `sub-main:${name}`, cloud: "azure" as const, subscriptionOrProject: "sub-main" },
    });
    const inventory = inventoryOf(["disk-unattached", "disk-attached"]);
    const ok = diffCheck(check("azure-waste-unattached-disks"), MANIFEST, { findings: [finding("disk-unattached", "fail"), finding("disk-attached", "pass")], coverage: [], inventory }, SUBS);
    expect(ok).toEqual({ checkId: "azure-waste-unattached-disks", result: "pass", defects: [] });
    const bad = diffCheck(check("azure-waste-unattached-disks"), MANIFEST, { findings: [finding("disk-unattached", "undetermined")], coverage: [], inventory }, SUBS);
    expect(bad).toMatchObject({ result: "fail", defects: ["disk-unattached: undetermined (expected fail)", "disk-attached: no finding (expected pass)"] });
  });
});
