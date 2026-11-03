import { afterAll, describe, expect, it } from "vitest";
import { validateInventory } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import { noOwnerTotal } from "./inventory.js";
import {
  applyOwnerLabel,
  gcpResourceUri,
  inventoryFromGcpManifest,
  projectOf,
  stripGcpPayload,
  type GcpGroundTruthManifest,
} from "./gcp-inventory.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/gcp/ground-truth.json"), "utf8"),
) as GcpGroundTruthManifest;
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("gcp inventory mapping", () => {
  it("maps the GCP manifest onto the shared contract and drops payload fields", () => {
    const dirty = {
      ownerLabelKey: "owner",
      items: [
        {
          id: "disk-parked",
          project: "farside-test",
          type: "compute.googleapis.com/Disk",
          title: "Unattached persistent disk",
          region: "us-central1-a",
          properties: { usersCount: 0 },
          labels: {},
          payload: { raw: true },
          gcpResource: { name: "secret" },
        },
      ],
    };
    const first = dirty.items[0];
    expect(first).toBeDefined();
    const stripped = stripGcpPayload(first as unknown as Record<string, unknown>);
    expect(stripped.payload).toBeUndefined();
    expect(stripped.gcpResource).toBeUndefined();

    const inventory = inventoryFromGcpManifest(dirty as GcpGroundTruthManifest);
    expect(validateInventory(inventory)).toEqual([]);
    expect(inventory.cloud).toBe("gcp");
    expect(inventory.resources).toHaveLength(1);
    expect(inventory.resources[0]).toMatchObject({
      resourceType: "compute.googleapis.com/Disk",
      displayName: "Unattached persistent disk",
      ownerTag: null,
      tags: {},
    });
    expect(JSON.stringify(inventory)).not.toMatch(/gcpResource|"payload"/);
  });

  it("counts owner-label gaps against the seeded unlabeled disk", () => {
    const inventory = inventoryFromGcpManifest(MANIFEST);
    expect(validateInventory(inventory)).toEqual([]);
    const missing = noOwnerTotal(inventory);
    expect(missing.total).toBe(1);
    expect(missing.resourceUris).toEqual([
      "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/disks/disk-parked",
    ]);
    expect(projectOf(missing.resourceUris[0] ?? "")).toBe("farside-test");
  });

  it("remaps owner-label gaps when the label key changes", () => {
    const inventory = inventoryFromGcpManifest(MANIFEST);
    expect(noOwnerTotal(inventory).total).toBe(1);
    const remapped = applyOwnerLabel(inventory, "cost-center");
    expect(noOwnerTotal(remapped).total).toBe(inventory.resources.length);
  });
});

describe("gcp inventory routes", () => {
  const store = new MemoryStore();
  const app = buildApp(store);

  afterAll(async () => {
    await app.close();
  });

  it("returns the unlabeled disk from stored GCP inventory", async () => {
    const inventory = inventoryFromGcpManifest(MANIFEST);
    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: inventory,
    });
    expect(put.statusCode).toBe(200);
    const noOwner = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/no-owner",
      headers: ORG,
    });
    expect(noOwner.statusCode).toBe(200);
    expect(noOwner.json()).toEqual({
      total: 1,
      resourceUris: [
        gcpResourceUri({
          id: "disk-parked",
          project: "farside-test",
          type: "compute.googleapis.com/Disk",
          title: "Unattached persistent disk",
          region: "us-central1-a",
          labels: {},
        }),
      ],
    });
  });

  it("remaps stored GCP owner-label gaps when Settings.ownerTagKey changes", async () => {
    const inventory = inventoryFromGcpManifest(MANIFEST);
    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: inventory,
    });
    expect(put.statusCode).toBe(200);
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
    const noOwner = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/no-owner",
      headers: ORG,
    });
    expect(noOwner.statusCode).toBe(200);
    expect(noOwner.json().total).toBe(inventory.resources.length);
  });
});
