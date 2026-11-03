import { assertValid, validateInventory, type Inventory, type InventoryRecord } from "@farside/scan-contracts";
import type { ResourceFacts } from "./facts.js";
import { applyOwnerTag } from "./inventory.js";

export const GCP_OWNER_LABEL_KEY = "owner";
export const GCP_TEST_PROJECT = "farside-test";

const COLLECTIONS: Record<string, string> = {
  Disk: "disks",
  Address: "addresses",
  Snapshot: "snapshots",
  Image: "images",
  Instance: "instances",
  Cluster: "clusters",
};

export type GcpGroundTruthItem = {
  id: string;
  project: string;
  type: string;
  title: string;
  region: string;
  labels: Record<string, string>;
  properties?: Record<string, string | number | boolean | null>;
};

export type GcpGroundTruthManifest = {
  ownerLabelKey: string;
  items: GcpGroundTruthItem[];
};

const ALLOWED_ITEM_KEYS = new Set(["id", "project", "type", "title", "region", "properties", "labels"]);

export function stripGcpPayload(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (ALLOWED_ITEM_KEYS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function gcpResourceUri(item: GcpGroundTruthItem): string {
  const [service, kind] = item.type.split("/");
  const collection = (kind && COLLECTIONS[kind]) || "resources";
  if (item.region === "global") {
    return `//${service}/projects/${item.project}/global/${collection}/${item.id}`;
  }
  if (service === "container.googleapis.com") {
    return `//${service}/projects/${item.project}/locations/${item.region}/${collection}/${item.id}`;
  }
  if (/-[a-z]$/.test(item.region)) {
    return `//${service}/projects/${item.project}/zones/${item.region}/${collection}/${item.id}`;
  }
  return `//${service}/projects/${item.project}/regions/${item.region}/${collection}/${item.id}`;
}

export { projectOf } from "./providers/gcp-scope.js";

/** GCP labels sit on InventoryRecord.tags; Settings.ownerTagKey is the owner label key. */
export const applyOwnerLabel = applyOwnerTag;

export function toGcpInventoryRecord(
  item: GcpGroundTruthItem,
  ownerLabelKey: string,
): InventoryRecord {
  const owner = item.labels[ownerLabelKey];
  return {
    resourceUri: gcpResourceUri(item),
    resourceType: item.type,
    region: item.region,
    displayName: item.title,
    tags: { ...item.labels },
    ownerTag: owner && owner.length > 0 ? owner : null,
  };
}

export function inventoryFromGcpManifest(
  manifest: GcpGroundTruthManifest,
  observedAt = "1970-01-01T00:00:00.000Z",
): Inventory {
  const inventory: Inventory = {
    cloud: "gcp",
    observedAt,
    resources: manifest.items.map((item) =>
      toGcpInventoryRecord(
        stripGcpPayload(item as unknown as Record<string, unknown>) as GcpGroundTruthItem,
        manifest.ownerLabelKey,
      ),
    ),
  };
  assertValid(validateInventory(inventory));
  return inventory;
}

export function factsFromGcpManifest(manifest: GcpGroundTruthManifest): ResourceFacts[] {
  return manifest.items.map((item) => {
    const fields: Record<string, string | number | boolean | null> = {
      location: item.region,
      ...(item.properties ?? {}),
    };
    if (item.type === "compute.googleapis.com/Disk") {
      fields.diskId = item.id;
    }
    if (item.type === "compute.googleapis.com/Address") {
      fields.addressId = item.id;
    }
    if (item.type === "compute.googleapis.com/Snapshot") {
      fields.snapshotOrImageId = item.id;
    }
    if (item.type === "compute.googleapis.com/Image") {
      fields.snapshotOrImageId = item.id;
    }
    if (item.type === "sqladmin.googleapis.com/Instance") {
      fields.resourceKind = "sql";
    }
    if (item.type === "container.googleapis.com/Cluster") {
      fields.resourceKind = "gke";
    }
    return { resourceUri: gcpResourceUri(item), fields };
  });
}
