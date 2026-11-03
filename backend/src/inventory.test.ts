import { afterAll, describe, expect, it } from "vitest";
import { validateInventory } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import {
  inventoryFromManifest,
  noOwnerTotal,
  stripProviderPayload,
  type GroundTruthManifest,
} from "./inventory.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { secretPaths } from "./secrets.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("inventory mapping", () => {
  it("maps the ground-truth manifest onto the shared contract and drops payload fields", () => {
    const dirty = {
      ownerTagKey: "owner",
      items: [
        {
          id: "disk-unattached",
          subscription: "main",
          type: "Microsoft.Compute/disks",
          title: "Unattached managed disk",
          properties: { diskState: "Unattached" },
          tags: {},
          payload: { raw: true },
          armBody: { id: "arm" },
          sdkResponse: { value: 1 },
        },
      ],
    };
    const first = dirty.items[0];
    expect(first).toBeDefined();
    const stripped = stripProviderPayload(first as unknown as Record<string, unknown>);
    expect(stripped.payload).toBeUndefined();
    expect(stripped.armBody).toBeUndefined();
    expect(stripped.sdkResponse).toBeUndefined();

    const inventory = inventoryFromManifest(dirty as GroundTruthManifest);
    expect(validateInventory(inventory)).toEqual([]);
    expect(inventory.resources).toHaveLength(1);
    expect(inventory.resources[0]).toMatchObject({
      resourceType: "Microsoft.Compute/disks",
      displayName: "Unattached managed disk",
      ownerTag: null,
      tags: {},
    });
    expect(inventory.resources[0]).not.toHaveProperty("properties");
    expect(inventory.resources[0]).not.toHaveProperty("payload");
    expect(JSON.stringify(inventory)).not.toMatch(/armBody|sdkResponse|"payload"/);
  });

  it("computes no-owner totals against the seeded untagged disk", () => {
    const inventory = inventoryFromManifest(MANIFEST);
    expect(validateInventory(inventory)).toEqual([]);
    const missing = noOwnerTotal(inventory);
    expect(missing.total).toBe(1);
    expect(missing.resourceUris).toEqual([
      "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/disk-unattached",
    ]);
  });
});

describe("inventory routes", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, TEST_APP_OPTIONS);
  const inventory = inventoryFromManifest(MANIFEST);

  afterAll(async () => {
    await app.close();
  });

  it("stores contract inventory and returns the untagged disk in no-owner totals", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: inventory,
    });
    expect(put.statusCode).toBe(200);
    expect(validateInventory(put.json())).toEqual([]);
    expect(secretPaths(put.json())).toEqual([]);

    const noOwner = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/no-owner",
      headers: ORG,
    });
    expect(noOwner.statusCode).toBe(200);
    expect(noOwner.json()).toEqual({
      total: 1,
      resourceUris: [
        "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/disk-unattached",
      ],
    });
  });

  it("keys GCP PUT coverage and browse on the project, not URI index 2", async () => {
    const gcp = {
      cloud: "gcp" as const,
      observedAt: "1970-01-01T00:00:00.000Z",
      resources: [
        {
          resourceUri: "//compute.googleapis.com/projects/p1/zones/us-central1-a/disks/parked",
          resourceType: "compute.googleapis.com/Disk",
          region: "us-central1-a",
          displayName: "parked",
          tags: {},
          ownerTag: null,
        },
      ],
    };
    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: gcp,
    });
    expect(put.statusCode).toBe(200);

    const coverage = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/coverage?cloud=gcp",
      headers: ORG,
    });
    const entries = coverage.json().entries as Array<{ id: string; checkId: string; subscriptionOrProject: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.subscriptionOrProject === "p1")).toBe(true);
    expect(entries.every((entry) => entry.id.startsWith("p1:gcp-"))).toBe(true);
    expect(entries.some((entry) => entry.checkId === "gcp-waste-unattached-disks")).toBe(true);
    expect(entries.some((entry) => entry.id === "compute.googleapis.com:azure-inventory-all-resources")).toBe(
      false,
    );

    const browse = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/browse?subscription=p1",
      headers: ORG,
    });
    expect(browse.json().total).toBe(1);
    expect(browse.json().resources[0].resourceUri).toBe(gcp.resources[0].resourceUri);
    expect(browse.json().resources[0].subscriptionOrProject).toBe("p1");
    expect(browse.json().resources[0].cloud).toBe("gcp");

    const miss = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/browse?subscription=compute.googleapis.com",
      headers: ORG,
    });
    expect(miss.json().total).toBe(0);
  });

  it("rejects raw provider payload fields on store", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: { ...inventory, payload: { armBody: { keys: true } } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().title).toBe("Invalid inventory");
  });
});
