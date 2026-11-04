import { describe, expect, it } from "vitest";
import { COVERAGE_CAUSES } from "./causes.js";
import {
  LAUNCH_RESOURCE_TYPES,
  TYPE_PROJECTION,
  fixtureResourceGraphClient,
  fixtureRowsFromManifest,
  harvestResourceGraph,
  itemToRow,
  launchQuery,
  readAllResourceGraphPages,
  typeQuery,
} from "./resource-graph.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const ALL_TYPES_QUERY = launchQuery();

describe("Resource Graph launch types", () => {
  it("projects every launch type Farside harvests", () => {
    expect(LAUNCH_RESOURCE_TYPES).toHaveLength(10);
    for (const type of LAUNCH_RESOURCE_TYPES) {
      expect(TYPE_PROJECTION[type].length).toBeGreaterThan(0);
      expect(typeQuery(type)).toContain(type);
      expect(typeQuery(type)).toMatch(/project /);
    }
    expect(ALL_TYPES_QUERY).toContain("in~");
    for (const type of LAUNCH_RESOURCE_TYPES) {
      expect(ALL_TYPES_QUERY.toLowerCase()).toContain(type.toLowerCase());
    }
  });
});

describe("Resource Graph paging", () => {
  it("follows skipToken until every fixture row is read", async () => {
    const expected = fixtureRowsFromManifest();
    const client = fixtureResourceGraphClient({ pageSize: 4 });
    const rows = await readAllResourceGraphPages(client, { subscriptionId: "main", query: ALL_TYPES_QUERY });
    expect(rows.map((row) => row.id).sort()).toEqual(expected.map((row) => row.id).sort());
    expect(rows.length).toBeGreaterThan(4);
  });

  it("pages each launch type on its own query", async () => {
    const client = fixtureResourceGraphClient({ pageSize: 1 });
    const harvested = await harvestResourceGraph({
      client,
      subscriptionId: "main",
      settings: DEFAULT_SETTINGS,
    });
    expect(harvested.ok).toBe(true);
    expect(harvested.queriedTypes).toEqual([...LAUNCH_RESOURCE_TYPES]);
    const expected = fixtureRowsFromManifest();
    expect(harvested.rows).toHaveLength(expected.length);
    expect(harvested.inventory.resources.map((row) => row.resourceUri).sort()).toEqual(
      expected.map((row) => row.id).sort(),
    );
    expect(harvested.coverage.find((entry) => entry.checkId === "azure-inventory-all-resources")?.state).toBe(
      "assessed",
    );
    expect(harvested.inventory.resources.find((row) => row.displayName === "Unattached managed disk")?.ownerTag).toBeNull();
  });
});

describe("Resource Graph throttle and failed call", () => {
  it("marks remaining types undetermined when Azure returns 429", async () => {
    const client = fixtureResourceGraphClient({ pageSize: 1, throttleOnPage: 0 });
    const harvested = await harvestResourceGraph({ client, subscriptionId: "main" });
    expect(harvested.ok).toBe(false);
    expect(harvested.reason).toBe("throttling");
    expect(harvested.queriedTypes).toEqual([]);
    const inventory = harvested.coverage.find((entry) => entry.checkId === "azure-inventory-all-resources");
    expect(inventory).toMatchObject({
      state: "undetermined",
      causeId: "throttling",
      reason: COVERAGE_CAUSES.throttling.reason,
    });
    expect(harvested.coverage.some((entry) => entry.checkId === "azure-waste-unattached-disks")).toBe(true);
  });

  it("keeps earlier types and records failed_call when a later page errors", async () => {
    const client = fixtureResourceGraphClient({ pageSize: 2, failAfterTypes: 1 });
    const harvested = await harvestResourceGraph({ client, subscriptionId: "main" });
    expect(harvested.ok).toBe(false);
    expect(harvested.reason).toBe("failed_call");
    expect(harvested.queriedTypes.length).toBeGreaterThan(0);
    expect(harvested.rows.length).toBeGreaterThan(0);
    expect(
      harvested.coverage.every((entry) => entry.state === "undetermined" && entry.causeId === "failed_call"),
    ).toBe(true);
    expect(harvested.coverage.find((entry) => entry.checkId === "azure-inventory-all-resources")?.reason).toBe(
      COVERAGE_CAUSES.failed_call.reason,
    );
  });
});

describe("Resource Graph row mapping", () => {
  it("keeps identifiers and drops nothing the inventory contract needs", () => {
    const row = itemToRow({
      id: "disk-unattached",
      subscription: "main",
      type: "Microsoft.Compute/disks",
      title: "Unattached managed disk",
      properties: { diskState: "Unattached" },
      tags: {},
    });
    expect(row.id).toBe(
      "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/disk-unattached",
    );
    expect(row.type).toBe("Microsoft.Compute/disks");
    expect(row.properties).toEqual({ diskState: "Unattached" });
  });
});
