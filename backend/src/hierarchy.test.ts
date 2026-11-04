import { describe, expect, it } from "vitest";
import {
  FIXTURE_ROOT_MG,
  FIXTURE_TEST_MG,
  discoverHierarchy,
  fixtureHierarchy,
  fixtureHierarchyClient,
} from "./hierarchy.js";
import { ProviderNotConfiguredError } from "./providers/unconfigured.js";
import { unconfiguredHierarchyClient } from "./hierarchy.js";

describe("Azure hierarchy discovery", () => {
  it("lists the fixture management groups and both ground-truth subscriptions", async () => {
    const hierarchy = await discoverHierarchy(fixtureHierarchyClient());
    expect(hierarchy.managementGroups.map((group) => group.id)).toEqual([FIXTURE_ROOT_MG, FIXTURE_TEST_MG]);
    expect(hierarchy.managementGroups[1]).toMatchObject({
      id: FIXTURE_TEST_MG,
      parentId: FIXTURE_ROOT_MG,
    });
    expect(hierarchy.subscriptions.map((subscription) => subscription.id).sort()).toEqual([
      "empty-no-budget",
      "main",
    ]);
    expect(hierarchy.subscriptions.every((subscription) => subscription.managementGroupId === FIXTURE_TEST_MG)).toBe(
      true,
    );
    expect(hierarchy.subscriptions.find((subscription) => subscription.id === "empty-no-budget")?.displayName).toMatch(
      /no budget/,
    );
  });

  it("keeps the fixture tenant id off the live ARM path", () => {
    const seeded = fixtureHierarchy();
    expect(seeded.tenantId).toBe("tenant-farside-test");
    expect(seeded.subscriptions).toHaveLength(2);
  });

  it("refuses an unconfigured live client", async () => {
    await expect(discoverHierarchy(unconfiguredHierarchyClient())).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});
