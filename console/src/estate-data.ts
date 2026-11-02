import type { InventoryRecord } from "@farside/scan-contracts";

export type EstateOverview = {
  empty: boolean;
  resourceTotal: number;
  noOwnerTotal: number;
  coverage: { assessed: number; unassessed: number; undetermined: number };
  healthScore: null;
};

export const EMPTY_OVERVIEW: EstateOverview = {
  empty: true,
  resourceTotal: 0,
  noOwnerTotal: 0,
  coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
  healthScore: null,
};

export const SEEDED_RESOURCES: InventoryRecord[] = [
  {
    resourceUri:
      "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/disk-unattached",
    resourceType: "Microsoft.Compute/disks",
    region: "eastus",
    displayName: "Unattached managed disk",
    tags: {},
    ownerTag: null,
  },
  {
    resourceUri:
      "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/disk-attached",
    resourceType: "Microsoft.Compute/disks",
    region: "eastus",
    displayName: "Disk attached to the deallocated VM",
    tags: { owner: "farside-test" },
    ownerTag: "farside-test",
  },
  {
    resourceUri:
      "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/virtualMachines/vm-prod-no-backup",
    resourceType: "Microsoft.Compute/virtualMachines",
    region: "westus",
    displayName: "Production VM",
    tags: { owner: "farside-test", environment: "prod" },
    ownerTag: "farside-test",
  },
  {
    resourceUri:
      "/subscriptions/empty-no-budget/resourceGroups/farside-seed/providers/Microsoft.Network/publicIPAddresses/pip-unassociated",
    resourceType: "Microsoft.Network/publicIPAddresses",
    region: "eastus",
    displayName: "Public IP with no ipConfiguration",
    tags: { owner: "farside-test" },
    ownerTag: "farside-test",
  },
];

export const SEEDED_OVERVIEW: EstateOverview = {
  empty: false,
  resourceTotal: SEEDED_RESOURCES.length,
  noOwnerTotal: 1,
  coverage: { assessed: 2, unassessed: 17, undetermined: 1 },
  healthScore: null,
};

export function applyOwnerTagKey(
  resources: InventoryRecord[],
  ownerTagKey: string,
): InventoryRecord[] {
  return resources.map((resource) => {
    const owner = resource.tags[ownerTagKey];
    return { ...resource, ownerTag: owner && owner.length > 0 ? owner : null };
  });
}

export function noOwnerCount(resources: InventoryRecord[]): number {
  return resources.filter((resource) => !resource.ownerTag).length;
}
