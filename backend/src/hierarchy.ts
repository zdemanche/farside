import { rejectUnconfigured } from "./providers/unconfigured.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };

export const FIXTURE_TENANT_ID = "tenant-farside-test";
export const FIXTURE_ROOT_MG = "mg-farside-root";
export const FIXTURE_TEST_MG = "mg-farside-test";

export type ManagementGroup = {
  id: string;
  displayName: string;
  parentId: string | null;
};

export type HierarchySubscription = {
  id: string;
  displayName: string;
  tenantId: string;
  managementGroupId: string;
};

export type AzureHierarchy = {
  tenantId: string;
  managementGroups: ManagementGroup[];
  subscriptions: HierarchySubscription[];
};

export type HierarchyClient = {
  listManagementGroups: () => Promise<ManagementGroup[]>;
  listSubscriptions: () => Promise<HierarchySubscription[]>;
};

type ManifestSubscriptions = {
  subscriptions: Array<{ id: string; role: string; empty: boolean }>;
};

const MANIFEST = docAzureGroundTruth as ManifestSubscriptions;

export function fixtureHierarchy(tenantId = FIXTURE_TENANT_ID): AzureHierarchy {
  return {
    tenantId,
    managementGroups: [
      { id: FIXTURE_ROOT_MG, displayName: "Farside test tenant", parentId: null },
      { id: FIXTURE_TEST_MG, displayName: "Farside test estate", parentId: FIXTURE_ROOT_MG },
    ],
    subscriptions: MANIFEST.subscriptions.map((subscription) => ({
      id: subscription.id,
      displayName: subscription.empty ? "Empty subscription with no budget" : "Seeded waste subscription",
      tenantId,
      managementGroupId: FIXTURE_TEST_MG,
    })),
  };
}

export function fixtureHierarchyClient(hierarchy: AzureHierarchy = fixtureHierarchy()): HierarchyClient {
  return {
    async listManagementGroups() {
      return hierarchy.managementGroups.map((group) => ({ ...group }));
    },
    async listSubscriptions() {
      return hierarchy.subscriptions.map((subscription) => ({ ...subscription }));
    },
  };
}

export function unconfiguredHierarchyClient(): HierarchyClient {
  return {
    async listManagementGroups() {
      rejectUnconfigured();
    },
    async listSubscriptions() {
      rejectUnconfigured();
    },
  };
}

export async function discoverHierarchy(client: HierarchyClient): Promise<AzureHierarchy> {
  const managementGroups = await client.listManagementGroups();
  const subscriptions = await client.listSubscriptions();
  const tenantId = subscriptions[0]?.tenantId ?? FIXTURE_TENANT_ID;
  return { tenantId, managementGroups, subscriptions };
}
