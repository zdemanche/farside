import {
  assertValid,
  validateInventory,
  type Cloud,
  type Inventory,
  type InventoryRecord,
} from "@farside/scan-contracts";
import { scopeOf } from "./scope.js";

export type GroundTruthItem = {
  id: string;
  subscription: string;
  type: string;
  title: string;
  tags: Record<string, string>;
  properties?: Record<string, string | number | boolean | null>;
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

export function applyOwnerTag(inventory: Inventory, ownerTagKey: string): Inventory {
  return {
    ...inventory,
    resources: inventory.resources.map((resource) => {
      const owner = resource.tags[ownerTagKey];
      return {
        ...resource,
        ownerTag: owner && owner.length > 0 ? owner : null,
      };
    }),
  };
}

export type InventoryFilters = {
  owner?: string;
  service?: string;
  subscription?: string;
  region?: string;
  cloud?: Cloud;
};

export type BrowsableResource = InventoryRecord & { cloud: Cloud };

export function filterInventory(
  inventory: Inventory,
  filters: InventoryFilters,
): BrowsableResource[] {
  if (filters.cloud && inventory.cloud !== filters.cloud) {
    return [];
  }
  return inventory.resources.flatMap((resource) => {
    if (filters.owner === "none" && resource.ownerTag) {
      return [];
    }
    if (filters.owner && filters.owner !== "none" && resource.ownerTag !== filters.owner) {
      return [];
    }
    if (filters.service && resource.resourceType !== filters.service) {
      return [];
    }
    if (filters.subscription && scopeOf(inventory.cloud, resource.resourceUri) !== filters.subscription) {
      return [];
    }
    if (filters.region && resource.region !== filters.region) {
      return [];
    }
    return [{ ...resource, cloud: inventory.cloud }];
  });
}

export function browseInventories(
  inventories: Inventory[],
  filters: InventoryFilters,
): BrowsableResource[] {
  return inventories.flatMap((inventory) => filterInventory(inventory, filters));
}

export function groupInventory(resources: InventoryRecord[]): {
  byOwner: Record<string, number>;
  byService: Record<string, number>;
} {
  const byOwner: Record<string, number> = {};
  const byService: Record<string, number> = {};
  for (const resource of resources) {
    const owner = resource.ownerTag ?? "none";
    byOwner[owner] = (byOwner[owner] ?? 0) + 1;
    byService[resource.resourceType] = (byService[resource.resourceType] ?? 0) + 1;
  }
  return { byOwner, byService };
}
