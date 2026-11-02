import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { recordCoverageScope } from "./coverage.js";
import { estateOverview } from "./estate.js";
import { applyOwnerTag, filterInventory, groupInventory, inventoryFromManifest, noOwnerTotal, type GroundTruthManifest } from "./inventory.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("estate overview", () => {
  it("is empty with no health score before a scan", () => {
    const overview = estateOverview(new MemoryStore().snapshot("org-a"));
    expect(overview).toEqual({
      empty: true,
      resourceTotal: 0,
      noOwnerTotal: 0,
      coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
      healthScore: null,
    });
  });

  it("shows totals, no-owner count and coverage on seeded inventory", () => {
    const store = new MemoryStore();
    const inventory = inventoryFromManifest(MANIFEST);
    store.putInventory("org-a", inventory);
    store.putCoverage("org-a", [
      recordCoverageScope({
        subscriptionOrProject: "main",
        checkId: "azure-inventory-all-resources",
        state: "assessed",
      }),
      recordCoverageScope({
        subscriptionOrProject: "main",
        checkId: "azure-waste-unattached-disks",
        state: "unassessed",
        causeId: "not_run",
      }),
      recordCoverageScope({
        subscriptionOrProject: "main",
        checkId: "azure-resilience-prod-vms-outside-backup",
        state: "undetermined",
        causeId: "missing_role",
      }),
    ]);
    const overview = estateOverview(store.snapshot("org-a"));
    expect(overview.empty).toBe(false);
    expect(overview.resourceTotal).toBe(inventory.resources.length);
    expect(overview.noOwnerTotal).toBe(1);
    expect(overview.coverage).toEqual({ assessed: 1, unassessed: 1, undetermined: 1 });
    expect(overview.healthScore).toBeNull();
  });
});

describe("inventory browse and settings", () => {
  const store = new MemoryStore();
  const app = buildApp(store);
  const inventory = inventoryFromManifest(MANIFEST);

  afterAll(async () => {
    await app.close();
  });

  it("filters and groups match stored inventory counts", async () => {
    await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: inventory,
    });
    const all = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/browse",
      headers: ORG,
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(inventory.resources.length);
    expect(all.json().grouped.byOwner.none).toBe(1);
    expect(all.json().grouped.byService["Microsoft.Compute/disks"]).toBe(2);

    const none = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/browse?owner=none",
      headers: ORG,
    });
    expect(none.json().total).toBe(1);
    expect(none.json().resources[0].displayName).toBe("Unattached managed disk");

    const disks = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/browse?service=Microsoft.Compute/disks",
      headers: ORG,
    });
    expect(disks.json().total).toBe(2);

    const main = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/browse?subscription=main",
      headers: ORG,
    });
    expect(main.json().total).toBe(inventory.resources.length);

    const eastus = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/browse?region=eastus",
      headers: ORG,
    });
    expect(eastus.json().total).toBe(inventory.resources.length);
    expect(groupInventory(filterInventory(inventory, { region: "eastus" })).byService).toEqual(
      eastus.json().grouped.byService,
    );
  });

  it("changes no-owner totals when the owner tag key changes", async () => {
    const before = noOwnerTotal(store.snapshot("org-a").inventory!).total;
    expect(before).toBe(1);
    const saved = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/settings",
      headers: ORG,
      payload: {
        ownerTagKey: "cost-center",
        productionTagKey: "environment",
        productionTagValue: "prod",
      },
    });
    expect(saved.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/no-owner",
      headers: ORG,
    });
    expect(after.json().total).toBe(inventory.resources.length);
    expect(after.json().total).toBeGreaterThan(before);
    expect(applyOwnerTag(inventory, "cost-center").resources.every((row) => row.ownerTag === null)).toBe(
      true,
    );

    const estate = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/estate",
      headers: ORG,
    });
    expect(estate.json().healthScore).toBeNull();
    expect(estate.json().noOwnerTotal).toBe(inventory.resources.length);
  });
});
