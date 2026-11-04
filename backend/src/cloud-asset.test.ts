import { describe, expect, it } from "vitest";
import { COVERAGE_CAUSES } from "./causes.js";
import {
  LAUNCH_ASSET_TYPES,
  fixtureAssetsFromManifest,
  fixtureCloudAssetClient,
  harvestCloudAssets,
  itemToAsset,
  readAllCloudAssetPages,
} from "./cloud-asset.js";
import { GCP_TEST_PROJECT } from "./gcp-inventory.js";
import { DEFAULT_SETTINGS } from "./settings.js";

describe("Cloud Asset launch types", () => {
  it("lists every GCP type the fixture harvests", () => {
    expect(LAUNCH_ASSET_TYPES).toHaveLength(9);
    const assets = fixtureAssetsFromManifest();
    const types = new Set(assets.map((asset) => asset.assetType));
    for (const type of LAUNCH_ASSET_TYPES) {
      expect(types.has(type)).toBe(true);
    }
  });
});

describe("Cloud Asset paging", () => {
  it("follows pageToken until every fixture asset is read", async () => {
    const expected = fixtureAssetsFromManifest();
    const client = fixtureCloudAssetClient({ pageSize: 2 });
    const assets: typeof expected = [];
    for (const assetType of LAUNCH_ASSET_TYPES) {
      assets.push(...(await readAllCloudAssetPages(client, { projectId: GCP_TEST_PROJECT, assetType })));
    }
    expect(assets.map((asset) => asset.name).sort()).toEqual(expected.map((asset) => asset.name).sort());
    expect(assets.length).toBeGreaterThan(2);
  });

  it("pages each launch type on its own list", async () => {
    const client = fixtureCloudAssetClient({ pageSize: 1 });
    const harvested = await harvestCloudAssets({
      client,
      projectId: GCP_TEST_PROJECT,
      settings: DEFAULT_SETTINGS,
    });
    expect(harvested.ok).toBe(true);
    expect(harvested.queriedTypes).toEqual([...LAUNCH_ASSET_TYPES]);
    const expected = fixtureAssetsFromManifest();
    expect(harvested.assets).toHaveLength(expected.length);
    expect(harvested.inventory.resources.map((row) => row.resourceUri).sort()).toEqual(
      expected.map((asset) => asset.name).sort(),
    );
    expect(harvested.coverage.find((entry) => entry.checkId === "gcp-inventory-all-assets")?.state).toBe(
      "assessed",
    );
    expect(harvested.inventory.resources.find((row) => row.displayName === "Unattached persistent disk")?.ownerTag).toBeNull();
  });
});

describe("Cloud Asset throttle and failed call", () => {
  it("marks remaining types undetermined when the list is throttled", async () => {
    const client = fixtureCloudAssetClient({ pageSize: 1, throttleOnPage: 0 });
    const harvested = await harvestCloudAssets({ client, projectId: GCP_TEST_PROJECT });
    expect(harvested.ok).toBe(false);
    expect(harvested.reason).toBe("throttling");
    expect(harvested.queriedTypes).toEqual([]);
    expect(harvested.coverage.find((entry) => entry.checkId === "gcp-inventory-all-assets")).toMatchObject({
      state: "undetermined",
      causeId: "throttling",
      reason: COVERAGE_CAUSES.throttling.reason,
    });
    expect(harvested.coverage.some((entry) => entry.checkId === "gcp-waste-unattached-disks")).toBe(true);
  });

  it("keeps earlier types and records failed_call when a later type errors", async () => {
    const client = fixtureCloudAssetClient({ pageSize: 2, failAfterTypes: 1 });
    const harvested = await harvestCloudAssets({ client, projectId: GCP_TEST_PROJECT });
    expect(harvested.ok).toBe(false);
    expect(harvested.reason).toBe("failed_call");
    expect(harvested.queriedTypes.length).toBeGreaterThan(0);
    expect(harvested.assets.length).toBeGreaterThan(0);
    expect(
      harvested.coverage.every((entry) => entry.state === "undetermined" && entry.causeId === "failed_call"),
    ).toBe(true);
    expect(harvested.coverage.find((entry) => entry.checkId === "gcp-inventory-all-assets")?.reason).toBe(
      COVERAGE_CAUSES.failed_call.reason,
    );
  });
});

describe("Cloud Asset row mapping", () => {
  it("keeps identifiers the inventory contract needs", () => {
    const asset = itemToAsset({
      id: "disk-parked",
      project: GCP_TEST_PROJECT,
      type: "compute.googleapis.com/Disk",
      title: "Unattached persistent disk",
      region: "us-central1-a",
      labels: {},
      properties: { usersCount: 0 },
    });
    expect(asset.name).toContain("disk-parked");
    expect(asset.assetType).toBe("compute.googleapis.com/Disk");
    expect(asset.project).toBe(GCP_TEST_PROJECT);
    expect(asset.labels).toEqual({});
  });
});
