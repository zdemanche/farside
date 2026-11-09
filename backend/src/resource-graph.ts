import { assertValid, validateInventory, type Inventory, type InventoryRecord } from "@farside/scan-contracts";
import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { resourceUriFor, type ResourceFacts } from "./facts.js";
import { applyOwnerTag, type GroundTruthItem, type GroundTruthManifest } from "./inventory.js";
import { AZURE_HARVEST_ASSESSED_CHECK_IDS, AZURE_LAUNCH_CHECK_IDS } from "./providers/launch-ids.js";
import { rejectUnconfigured } from "./providers/unconfigured.js";
import { DEFAULT_SETTINGS, type OrgSettings } from "./settings.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };

export const ARG_PAGE_LIMIT = 50;

export const LAUNCH_RESOURCE_TYPES = [
  "Microsoft.Compute/disks",
  "Microsoft.Network/publicIPAddresses",
  "Microsoft.Compute/snapshots",
  "Microsoft.Compute/virtualMachines",
  "Microsoft.Web/serverfarms",
  "Microsoft.Network/loadBalancers",
  "Microsoft.Network/natGateways",
  "Microsoft.Sql/servers/databases",
  "Microsoft.Web/certificates",
  "Microsoft.Network/applicationGateways",
] as const;

export type LaunchResourceType = (typeof LAUNCH_RESOURCE_TYPES)[number];

const BASE_COLUMNS = ["id", "type", "name", "location", "subscriptionId", "tags"] as const;

/**
 * Columns are aliased to the fact names the checks read, so a live Resource Graph row and a
 * fixture row have the same shape. Values that need the clock (ages, days left) are derived
 * after the read (`normaliseLiveRow` in azure-live-graph.ts). Unverified until a live run.
 */
export const TYPE_PROJECTION: Record<LaunchResourceType, readonly string[]> = {
  "Microsoft.Compute/disks": [
    ...BASE_COLUMNS,
    "diskState = tostring(properties.diskState)",
    "sizeGb = toint(properties.diskSizeGB)",
    "skuName = tostring(sku.name)",
    "attachedTo = tostring(managedBy)",
  ],
  "Microsoft.Network/publicIPAddresses": [
    ...BASE_COLUMNS,
    "associatedTo = coalesce(tostring(properties.ipConfiguration.id), tostring(properties.natGateway.id))",
    "skuName = tostring(sku.name)",
  ],
  "Microsoft.Compute/snapshots": [
    ...BASE_COLUMNS,
    "timeCreated = tostring(properties.timeCreated)",
    "sizeGb = toint(properties.diskSizeGB)",
  ],
  "Microsoft.Compute/virtualMachines": [
    ...BASE_COLUMNS,
    "vmSize = tostring(properties.hardwareProfile.vmSize)",
    "powerState = tostring(properties.extended.instanceView.powerState.code)",
  ],
  "Microsoft.Web/serverfarms": [
    ...BASE_COLUMNS,
    "numberOfSites = toint(properties.numberOfSites)",
    "skuName = tostring(sku.name)",
    "kind",
  ],
  "Microsoft.Network/loadBalancers": [
    ...BASE_COLUMNS,
    "backendPools = tostring(properties.backendAddressPools)",
    "skuName = tostring(sku.name)",
  ],
  "Microsoft.Network/natGateways": [
    ...BASE_COLUMNS,
    "attachedSubnetCount = coalesce(array_length(properties.subnets), 0)",
    "skuName = tostring(sku.name)",
  ],
  "Microsoft.Sql/servers/databases": [
    ...BASE_COLUMNS,
    "zoneRedundant = tobool(properties.zoneRedundant)",
    "backupRedundancy = tostring(properties.currentBackupStorageRedundancy)",
    "skuName = tostring(sku.name)",
  ],
  "Microsoft.Web/certificates": [
    ...BASE_COLUMNS,
    "expirationDate = tostring(properties.expirationDate)",
    "hostName = tostring(properties.hostNames[0])",
  ],
  "Microsoft.Network/applicationGateways": [
    ...BASE_COLUMNS,
    "certificateName = tostring(properties.sslCertificates[0].name)",
  ],
};

export const TYPE_CHECK_IDS: Record<LaunchResourceType, readonly string[]> = {
  "Microsoft.Compute/disks": ["azure-inventory-all-resources", "azure-inventory-no-owner-tag", "azure-waste-unattached-disks"],
  "Microsoft.Network/publicIPAddresses": [
    "azure-inventory-all-resources",
    "azure-inventory-no-owner-tag",
    "azure-waste-unassociated-public-ips",
  ],
  "Microsoft.Compute/snapshots": ["azure-inventory-all-resources", "azure-inventory-no-owner-tag", "azure-waste-old-snapshots"],
  "Microsoft.Compute/virtualMachines": [
    "azure-inventory-all-resources",
    "azure-inventory-no-owner-tag",
    "azure-waste-stopped-not-deallocated-vms",
    "azure-resilience-prod-vms-outside-backup",
    "azure-lifecycle-retiring-skus",
  ],
  "Microsoft.Web/serverfarms": ["azure-inventory-all-resources", "azure-inventory-no-owner-tag", "azure-waste-empty-app-service-plans"],
  "Microsoft.Network/loadBalancers": ["azure-inventory-all-resources", "azure-inventory-no-owner-tag", "azure-waste-idle-load-balancers"],
  "Microsoft.Network/natGateways": ["azure-inventory-all-resources", "azure-inventory-no-owner-tag", "azure-waste-idle-nat-gateways"],
  "Microsoft.Sql/servers/databases": [
    "azure-inventory-all-resources",
    "azure-inventory-no-owner-tag",
    "azure-resilience-prod-sql-outside-backup",
    "azure-resilience-db-zone-or-geo",
  ],
  "Microsoft.Web/certificates": [
    "azure-inventory-all-resources",
    "azure-inventory-no-owner-tag",
    "azure-lifecycle-expiring-app-service-certs",
  ],
  "Microsoft.Network/applicationGateways": [
    "azure-inventory-all-resources",
    "azure-inventory-no-owner-tag",
    "azure-lifecycle-expiring-gateway-certs",
  ],
};

export type ResourceGraphRow = {
  id: string;
  type: string;
  name: string;
  location: string;
  subscriptionId: string;
  tags: Record<string, string>;
  properties?: Record<string, string | number | boolean | null>;
};

export type ResourceGraphPage = {
  data: ResourceGraphRow[];
  skipToken?: string;
};

export type ResourceGraphClient = {
  query: (input: { subscriptionId: string; query: string; skipToken?: string }) => Promise<ResourceGraphPage>;
};

export class ResourceGraphThrottleError extends Error {
  constructor() {
    super("Resource Graph throttled the query");
    this.name = "ResourceGraphThrottleError";
  }
}

export class ResourceGraphFailedCallError extends Error {
  constructor() {
    super("Resource Graph call failed");
    this.name = "ResourceGraphFailedCallError";
  }
}

export type ResourceGraphHarvest = {
  ok: boolean;
  reason?: "throttling" | "failed_call";
  inventory: Inventory;
  facts: ResourceFacts[];
  coverage: CoverageEntry[];
  rows: ResourceGraphRow[];
  queriedTypes: LaunchResourceType[];
};

const MANIFEST = docAzureGroundTruth as GroundTruthManifest;

export function launchQuery(types: readonly string[] = LAUNCH_RESOURCE_TYPES): string {
  const listed = types.map((type) => `'${type.toLowerCase()}'`).join(", ");
  const projection = ["id", "name", "type", "location", "subscriptionId", "tags", "properties"];
  return `Resources | where type in~ (${listed}) | project ${projection.join(", ")}`;
}

export function typeQuery(type: string): string {
  const projection = TYPE_PROJECTION[type as LaunchResourceType] ?? [
    "id",
    "name",
    "type",
    "location",
    "subscriptionId",
    "tags",
    "properties",
  ];
  return `Resources | where type =~ '${type}' | project ${projection.join(", ")}`;
}

export function itemToRow(item: GroundTruthItem): ResourceGraphRow {
  const row: ResourceGraphRow = {
    id: resourceUriFor(item),
    type: item.type,
    name: item.title,
    location: "eastus",
    subscriptionId: item.subscription,
    tags: { ...item.tags },
  };
  if (item.properties) {
    row.properties = { ...item.properties };
  }
  return row;
}

function typeFromQuery(query: string): LaunchResourceType | undefined {
  if (query.includes("in~")) {
    return undefined;
  }
  return LAUNCH_RESOURCE_TYPES.find((type) => query.toLowerCase().includes(`'${type.toLowerCase()}'`));
}

export function fixtureResourceGraphClient(options?: {
  items?: readonly GroundTruthItem[];
  pageSize?: number;
  throttleOnPage?: number;
  failOnPage?: number;
  failAfterTypes?: number;
}): ResourceGraphClient {
  const items = options?.items ?? MANIFEST.items.filter((item) =>
    (LAUNCH_RESOURCE_TYPES as readonly string[]).includes(item.type),
  );
  const pageSize = options?.pageSize ?? 5;
  let startedTypes = 0;
  return {
    async query(input) {
      const type = typeFromQuery(input.query);
      const matching = items
        .filter((item) => item.subscription === input.subscriptionId)
        .filter((item) => (type ? item.type === type : (LAUNCH_RESOURCE_TYPES as readonly string[]).includes(item.type)))
        .map(itemToRow);
      const offset = input.skipToken ? Number(input.skipToken) : 0;
      if (!Number.isFinite(offset) || offset < 0) {
        return { data: [] };
      }
      if (input.skipToken === undefined) {
        if (options?.failAfterTypes !== undefined && startedTypes >= options.failAfterTypes) {
          throw new ResourceGraphFailedCallError();
        }
        startedTypes += 1;
      }
      const pageIndex = Math.floor(offset / pageSize);
      if (options?.failOnPage === pageIndex) {
        throw new ResourceGraphFailedCallError();
      }
      if (options?.throttleOnPage === pageIndex) {
        throw new ResourceGraphThrottleError();
      }
      const data = matching.slice(offset, offset + pageSize);
      const next = offset + pageSize;
      return next < matching.length ? { data, skipToken: String(next) } : { data };
    },
  };
}

export function unconfiguredResourceGraphClient(): ResourceGraphClient {
  return {
    async query() {
      rejectUnconfigured();
    },
  };
}

export async function readAllResourceGraphPages(
  client: ResourceGraphClient,
  input: { subscriptionId: string; query: string },
): Promise<ResourceGraphRow[]> {
  const rows: ResourceGraphRow[] = [];
  let skipToken: string | undefined;
  for (let safety = 0; safety < ARG_PAGE_LIMIT; safety += 1) {
    const page = await client.query(
      skipToken ? { ...input, skipToken } : { subscriptionId: input.subscriptionId, query: input.query },
    );
    rows.push(...page.data);
    if (!page.skipToken) {
      return rows;
    }
    skipToken = page.skipToken;
  }
  throw new Error("Resource Graph query exceeded page limit");
}

function rowToRecord(row: ResourceGraphRow, ownerTagKey: string): InventoryRecord {
  const owner = row.tags[ownerTagKey];
  return {
    resourceUri: row.id,
    resourceType: row.type,
    region: row.location,
    displayName: row.name,
    tags: { ...row.tags },
    ownerTag: owner && owner.length > 0 ? owner : null,
  };
}

function inventoryFromRows(
  rows: readonly ResourceGraphRow[],
  ownerTagKey: string,
  observedAt: string,
): Inventory {
  const inventory = applyOwnerTag(
    {
      cloud: "azure",
      observedAt,
      resources: rows.map((row) => rowToRecord(row, ownerTagKey)),
    },
    ownerTagKey,
  );
  assertValid(validateInventory(inventory));
  return inventory;
}

function factsFromRows(rows: readonly ResourceGraphRow[]): ResourceFacts[] {
  return rows.map((row) => ({
    resourceUri: row.id,
    fields: {
      location: row.location,
      ...(row.properties ?? {}),
    },
  }));
}

function coverageFor(
  subscriptionId: string,
  checkIds: readonly string[],
  state: CoverageEntry["state"],
  causeId?: "throttling" | "failed_call",
): CoverageEntry[] {
  return checkIds.map((checkId) =>
    recordCoverageScope({
      subscriptionOrProject: subscriptionId,
      checkId,
      state,
      ...(causeId ? { causeId } : {}),
    }),
  );
}

function assessedInventoryCoverage(subscriptionId: string): CoverageEntry[] {
  return AZURE_LAUNCH_CHECK_IDS.map((checkId) =>
    recordCoverageScope({
      subscriptionOrProject: subscriptionId,
      checkId,
      state: AZURE_HARVEST_ASSESSED_CHECK_IDS.has(checkId) ? "assessed" : "unassessed",
      ...(AZURE_HARVEST_ASSESSED_CHECK_IDS.has(checkId) ? {} : { causeId: "not_run" }),
    }),
  );
}

export async function harvestResourceGraph(input: {
  client: ResourceGraphClient;
  subscriptionId: string;
  settings?: OrgSettings;
  observedAt?: string;
}): Promise<ResourceGraphHarvest> {
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const observedAt = input.observedAt ?? "1970-01-01T00:00:00.000Z";
  const rows: ResourceGraphRow[] = [];
  const queriedTypes: LaunchResourceType[] = [];
  for (const type of LAUNCH_RESOURCE_TYPES) {
    try {
      let skipToken: string | undefined;
      for (let safety = 0; safety < ARG_PAGE_LIMIT; safety += 1) {
        const page = await input.client.query(
          skipToken
            ? { subscriptionId: input.subscriptionId, query: typeQuery(type), skipToken }
            : { subscriptionId: input.subscriptionId, query: typeQuery(type) },
        );
        rows.push(...page.data);
        if (!page.skipToken) {
          break;
        }
        skipToken = page.skipToken;
      }
      queriedTypes.push(type);
    } catch (error) {
      const reason = error instanceof ResourceGraphThrottleError ? "throttling" : "failed_call";
      const remaining = LAUNCH_RESOURCE_TYPES.filter((item) => !queriedTypes.includes(item));
      const checkIds = [...new Set(remaining.flatMap((item) => TYPE_CHECK_IDS[item]))];
      return {
        ok: false,
        reason,
        inventory: inventoryFromRows(rows, settings.ownerTagKey, observedAt),
        facts: factsFromRows(rows),
        coverage: coverageFor(input.subscriptionId, checkIds, "undetermined", reason),
        rows,
        queriedTypes,
      };
    }
  }
  return {
    ok: true,
    inventory: inventoryFromRows(rows, settings.ownerTagKey, observedAt),
    facts: factsFromRows(rows),
    coverage: assessedInventoryCoverage(input.subscriptionId),
    rows,
    queriedTypes,
  };
}

export function fixtureRowsFromManifest(
  manifest: GroundTruthManifest = MANIFEST,
  subscriptionId = "main",
): ResourceGraphRow[] {
  return manifest.items
    .filter((item) => item.subscription === subscriptionId)
    .filter((item) => (LAUNCH_RESOURCE_TYPES as readonly string[]).includes(item.type))
    .map(itemToRow);
}
