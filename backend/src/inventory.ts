import {
  assertValid,
  validateInventory,
  type Inventory,
  type InventoryRecord,
} from "@farside/scan-contracts";

export type GroundTruthItem = {
  id: string;
  subscription: string;
  type: string;
  title: string;
  tags: Record<string, string>;
};

export type GroundTruthManifest = {
  ownerTagKey: string;
  items: GroundTruthItem[];
};

const ALLOWED_ITEM_KEYS = new Set(["id", "subscription", "type", "title", "properties", "tags"]);

export function stripProviderPayload(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (ALLOWED_ITEM_KEYS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function toInventoryRecord(
  item: GroundTruthItem,
  ownerTagKey: string,
): InventoryRecord {
  const owner = item.tags[ownerTagKey];
  return {
    resourceUri: `/subscriptions/${item.subscription}/resourceGroups/farside-seed/providers/${item.type}/${item.id}`,
    resourceType: item.type,
    region: "eastus",
    displayName: item.title,
    tags: { ...item.tags },
    ownerTag: owner && owner.length > 0 ? owner : null,
  };
}

export function inventoryFromManifest(
  manifest: GroundTruthManifest,
  observedAt = "1970-01-01T00:00:00.000Z",
): Inventory {
  const inventory: Inventory = {
    cloud: "azure",
    observedAt,
    resources: manifest.items.map((item) =>
      toInventoryRecord(
        stripProviderPayload(item as unknown as Record<string, unknown>) as GroundTruthItem,
        manifest.ownerTagKey,
      ),
    ),
  };
  assertValid(validateInventory(inventory));
  return inventory;
}

export function noOwnerTotal(inventory: Inventory): {
  total: number;
  resourceUris: string[];
} {
  const missing = inventory.resources.filter((resource) => !resource.ownerTag);
  return {
    total: missing.length,
    resourceUris: missing.map((resource) => resource.resourceUri),
  };
}
