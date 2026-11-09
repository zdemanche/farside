import { assertValid, validateInventory, type Inventory } from "@farside/scan-contracts";
import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import {
  applyOwnerLabel,
  factsFromGcpManifest,
  gcpResourceUri,
  toGcpInventoryRecord,
  type GcpGroundTruthItem,
  type GcpGroundTruthManifest,
} from "./gcp-inventory.js";
import { GCP_HARVEST_ASSESSED_CHECK_IDS, GCP_LAUNCH_CHECK_IDS } from "./providers/launch-ids.js";
import { rejectUnconfigured } from "./providers/unconfigured.js";
import { DEFAULT_SETTINGS, type OrgSettings } from "./settings.js";
import docGcpGroundTruth from "../../docs/gcp/ground-truth.json" with { type: "json" };

export const ASSET_PAGE_LIMIT = 50;

export const LAUNCH_ASSET_TYPES = [
  "compute.googleapis.com/Disk",
  "compute.googleapis.com/Address",
  "compute.googleapis.com/Snapshot",
  "compute.googleapis.com/Image",
  "compute.googleapis.com/Instance",
  "sqladmin.googleapis.com/Instance",
  "container.googleapis.com/Cluster",
  "certificatemanager.googleapis.com/Certificate",
  "recommender.googleapis.com/Recommendation",
] as const;

export type LaunchAssetType = (typeof LAUNCH_ASSET_TYPES)[number];

export const TYPE_CHECK_IDS: Record<LaunchAssetType, readonly string[]> = {
  "compute.googleapis.com/Disk": [
    "gcp-inventory-all-assets",
    "gcp-inventory-no-owner-label",
    "gcp-waste-unattached-disks",
  ],
  "compute.googleapis.com/Address": [
    "gcp-inventory-all-assets",
    "gcp-inventory-no-owner-label",
    "gcp-waste-unused-external-ips",
  ],
  "compute.googleapis.com/Snapshot": [
    "gcp-inventory-all-assets",
    "gcp-inventory-no-owner-label",
    "gcp-waste-old-snapshots-and-images",
  ],
  "compute.googleapis.com/Image": [
    "gcp-inventory-all-assets",
    "gcp-inventory-no-owner-label",
    "gcp-waste-old-snapshots-and-images",
  ],
  "compute.googleapis.com/Instance": ["gcp-inventory-all-assets", "gcp-inventory-no-owner-label"],
  "sqladmin.googleapis.com/Instance": [
    "gcp-inventory-all-assets",
    "gcp-inventory-no-owner-label",
    "gcp-resilience-sql-ha-or-backup",
    "gcp-lifecycle-sql-gke-support",
  ],
  "container.googleapis.com/Cluster": [
    "gcp-inventory-all-assets",
    "gcp-inventory-no-owner-label",
    "gcp-lifecycle-sql-gke-support",
  ],
  "certificatemanager.googleapis.com/Certificate": [
    "gcp-inventory-all-assets",
    "gcp-inventory-no-owner-label",
    "gcp-lifecycle-expiring-certs",
  ],
  "recommender.googleapis.com/Recommendation": [
    "gcp-inventory-all-assets",
    "gcp-inventory-no-owner-label",
    "gcp-waste-idle-vm-and-disk-recommendations",
  ],
};

export type CloudAsset = {
  id: string;
  name: string;
  assetType: string;
  project: string;
  displayName: string;
  location: string;
  labels: Record<string, string>;
  properties?: Record<string, string | number | boolean | null>;
};

export type CloudAssetPage = {
  assets: CloudAsset[];
  pageToken?: string;
};

export type CloudAssetClient = {
  list: (input: { projectId: string; assetType: string; pageToken?: string }) => Promise<CloudAssetPage>;
};

export class CloudAssetThrottleError extends Error {
  constructor() {
    super("Cloud Asset Inventory throttled the list");
    this.name = "CloudAssetThrottleError";
  }
}

export class CloudAssetFailedCallError extends Error {
  constructor() {
    super("Cloud Asset Inventory call failed");
    this.name = "CloudAssetFailedCallError";
  }
}

export type CloudAssetHarvest = {
  ok: boolean;
  reason?: "throttling" | "failed_call";
  inventory: Inventory;
  facts: ResourceFacts[];
  coverage: CoverageEntry[];
  assets: CloudAsset[];
  queriedTypes: LaunchAssetType[];
};

const MANIFEST = docGcpGroundTruth as GcpGroundTruthManifest;

export function itemToAsset(item: GcpGroundTruthItem): CloudAsset {
  const asset: CloudAsset = {
    id: item.id,
    name: gcpResourceUri(item),
    assetType: item.type,
    project: item.project,
    displayName: item.title,
    location: item.region,
    labels: { ...item.labels },
  };
  if (item.properties) {
    asset.properties = { ...item.properties };
  }
  return asset;
}

export function assetToItem(asset: CloudAsset): GcpGroundTruthItem {
  const item: GcpGroundTruthItem = {
    id: asset.id,
    project: asset.project,
    type: asset.assetType,
    title: asset.displayName,
    region: asset.location,
    labels: { ...asset.labels },
  };
  if (asset.properties) {
    item.properties = { ...asset.properties };
  }
  return item;
}

export function fixtureCloudAssetClient(options?: {
  items?: readonly GcpGroundTruthItem[];
  pageSize?: number;
  throttleOnPage?: number;
  failAfterTypes?: number;
}): CloudAssetClient {
  const items = options?.items ?? MANIFEST.items.filter((item) =>
    (LAUNCH_ASSET_TYPES as readonly string[]).includes(item.type),
  );
  const pageSize = options?.pageSize ?? 2;
  let startedTypes = 0;
  return {
    async list(input) {
      const matching = items
        .filter((item) => item.project === input.projectId)
        .filter((item) => item.type === input.assetType)
        .map(itemToAsset);
      const offset = input.pageToken ? Number(input.pageToken) : 0;
      if (!Number.isFinite(offset) || offset < 0) {
        return { assets: [] };
      }
      if (input.pageToken === undefined) {
        if (options?.failAfterTypes !== undefined && startedTypes >= options.failAfterTypes) {
          throw new CloudAssetFailedCallError();
        }
        startedTypes += 1;
      }
      const pageIndex = Math.floor(offset / pageSize);
      if (options?.throttleOnPage === pageIndex) {
        throw new CloudAssetThrottleError();
      }
      const assets = matching.slice(offset, offset + pageSize);
      const next = offset + pageSize;
      return next < matching.length ? { assets, pageToken: String(next) } : { assets };
    },
  };
}

export function unconfiguredCloudAssetClient(): CloudAssetClient {
  return {
    async list() {
      rejectUnconfigured();
    },
  };
}

export async function readAllCloudAssetPages(
  client: CloudAssetClient,
  input: { projectId: string; assetType: string },
): Promise<CloudAsset[]> {
  const assets: CloudAsset[] = [];
  let pageToken: string | undefined;
  for (let safety = 0; safety < ASSET_PAGE_LIMIT; safety += 1) {
    const page = await client.list(pageToken ? { ...input, pageToken } : input);
    assets.push(...page.assets);
    if (!page.pageToken) {
      return assets;
    }
    pageToken = page.pageToken;
  }
  throw new Error("Cloud Asset list exceeded page limit");
}

export function inventoryFromAssets(
  assets: readonly CloudAsset[],
  ownerLabelKey: string,
  observedAt: string,
): Inventory {
  const inventory = applyOwnerLabel(
    {
      cloud: "gcp",
      observedAt,
      resources: assets.map((asset) => toGcpInventoryRecord(assetToItem(asset), ownerLabelKey)),
    },
    ownerLabelKey,
  );
  assertValid(validateInventory(inventory));
  return inventory;
}

export function factsFromAssets(assets: readonly CloudAsset[]): ResourceFacts[] {
  return factsFromGcpManifest({
    ownerLabelKey: "owner",
    items: assets.map(assetToItem),
  });
}

function coverageFor(
  projectId: string,
  checkIds: readonly string[],
  state: CoverageEntry["state"],
  causeId?: "throttling" | "failed_call",
): CoverageEntry[] {
  return checkIds.map((checkId) =>
    recordCoverageScope({
      subscriptionOrProject: projectId,
      checkId,
      state,
      ...(causeId ? { causeId } : {}),
    }),
  );
}

function assessedInventoryCoverage(projectId: string): CoverageEntry[] {
  return GCP_LAUNCH_CHECK_IDS.map((checkId) =>
    recordCoverageScope({
      subscriptionOrProject: projectId,
      checkId,
      state: GCP_HARVEST_ASSESSED_CHECK_IDS.has(checkId) ? "assessed" : "unassessed",
      ...(GCP_HARVEST_ASSESSED_CHECK_IDS.has(checkId) ? {} : { causeId: "not_run" }),
    }),
  );
}

export async function harvestCloudAssets(input: {
  client: CloudAssetClient;
  projectId: string;
  settings?: OrgSettings;
  observedAt?: string;
}): Promise<CloudAssetHarvest> {
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const observedAt = input.observedAt ?? "1970-01-01T00:00:00.000Z";
  const assets: CloudAsset[] = [];
  const queriedTypes: LaunchAssetType[] = [];
  for (const assetType of LAUNCH_ASSET_TYPES) {
    try {
      let pageToken: string | undefined;
      for (let safety = 0; safety < ASSET_PAGE_LIMIT; safety += 1) {
        const page = await input.client.list(
          pageToken
            ? { projectId: input.projectId, assetType, pageToken }
            : { projectId: input.projectId, assetType },
        );
        assets.push(...page.assets);
        if (!page.pageToken) {
          break;
        }
        pageToken = page.pageToken;
      }
      queriedTypes.push(assetType);
    } catch (error) {
      const reason = error instanceof CloudAssetThrottleError ? "throttling" : "failed_call";
      const remaining = LAUNCH_ASSET_TYPES.filter((item) => !queriedTypes.includes(item));
      const checkIds = [...new Set(remaining.flatMap((item) => TYPE_CHECK_IDS[item]))];
      return {
        ok: false,
        reason,
        inventory: inventoryFromAssets(assets, settings.ownerTagKey, observedAt),
        facts: factsFromAssets(assets),
        coverage: coverageFor(input.projectId, checkIds, "undetermined", reason),
        assets,
        queriedTypes,
      };
    }
  }
  return {
    ok: true,
    inventory: inventoryFromAssets(assets, settings.ownerTagKey, observedAt),
    facts: factsFromAssets(assets),
    coverage: assessedInventoryCoverage(input.projectId),
    assets,
    queriedTypes,
  };
}

export function fixtureAssetsFromManifest(
  manifest: GcpGroundTruthManifest = MANIFEST,
  projectId = "farside-test",
): CloudAsset[] {
  return manifest.items
    .filter((item) => item.project === projectId)
    .filter((item) => (LAUNCH_ASSET_TYPES as readonly string[]).includes(item.type))
    .map(itemToAsset);
}
