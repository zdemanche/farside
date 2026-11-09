import { readFile } from "node:fs/promises";
import {
  factsFromAssets,
  harvestCloudAssets,
  inventoryFromAssets,
  type CloudAsset,
  type CloudAssetClient,
} from "./cloud-asset.js";
import type { Clock } from "./clock.js";
import { applyCoverageResults } from "./coverage.js";
import {
  gcpFederatedTokenProvider,
  fileSubjectToken,
  type GcpTokenProvider,
} from "./gcp-federation.js";
import {
  CERT_ASSET_TYPE,
  GKE_ASSET_TYPE,
  GcpAccessDeniedError,
  GcpApiError,
  IDLE_RECOMMENDERS,
  MissingRecommenderRoleError,
  SQL_ASSET_TYPE,
  liveBigQueryExportClient,
  liveBillingExportDetector,
  liveCloudAssetClient,
  liveGcpPermissionTester,
  liveRecommenderClient,
  liveServiceReads,
  parseBillingTable,
  safeProjectId,
  type FetchLike,
  type GcpPermissionTester,
  type GcpServiceReads,
  type RecommenderClient,
} from "./gcp-live.js";
import {
  GCP_IDLE_RECS,
  RECOMMENDER_ROLE_CLOSER,
  REC_TYPE,
  type GcpRecommendation,
} from "./gcp-recommender.js";
import type { BigQueryExportClient } from "./gcp-cost.js";
import { providerFor } from "./providers/index.js";
import type { Harvester } from "./providers/types.js";
import { assertNoSecrets } from "./secrets.js";

/** Env names. Live GCP is off unless FARSIDE_GCP_LIVE=1 and every required name is set. */
export const GCP_LIVE_ENV = {
  flag: "FARSIDE_GCP_LIVE",
  projectId: "FARSIDE_GCP_PROJECT_ID",
  poolProjectNumber: "FARSIDE_GCP_POOL_PROJECT_NUMBER",
  poolId: "FARSIDE_GCP_POOL_ID",
  providerId: "FARSIDE_GCP_PROVIDER_ID",
  serviceAccount: "FARSIDE_GCP_SERVICE_ACCOUNT",
  subjectTokenFile: "FARSIDE_GCP_SUBJECT_TOKEN_FILE",
  awsWebIdentityTokenFile: "AWS_WEB_IDENTITY_TOKEN_FILE",
  billingTable: "FARSIDE_GCP_BILLING_EXPORT_TABLE",
  jobProjectId: "FARSIDE_GCP_BIGQUERY_JOB_PROJECT",
} as const;

export type GcpLiveConfig = {
  projectId: string;
  poolProjectNumber: string;
  poolId: string;
  providerId: string;
  serviceAccount: string;
  /** Path to an OIDC token file. A path, not a secret. */
  subjectTokenPath: string;
  billingTable?: string;
  jobProjectId: string;
};

export class GcpLiveConfigError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`FARSIDE_GCP_LIVE=1 but these are not set: ${missing.join(", ")}`);
    this.name = "GcpLiveConfigError";
  }
}

/** Null when live GCP is not switched on. Throws when it is switched on but incomplete. */
export function gcpLiveConfigFromEnv(env: NodeJS.Dict<string> = process.env): GcpLiveConfig | null {
  if (env[GCP_LIVE_ENV.flag] !== "1") {
    return null;
  }
  const read = (name: string) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };
  const required = {
    projectId: read(GCP_LIVE_ENV.projectId),
    poolProjectNumber: read(GCP_LIVE_ENV.poolProjectNumber),
    poolId: read(GCP_LIVE_ENV.poolId),
    providerId: read(GCP_LIVE_ENV.providerId),
    serviceAccount: read(GCP_LIVE_ENV.serviceAccount),
    subjectTokenPath:
      read(GCP_LIVE_ENV.subjectTokenFile) ?? read(GCP_LIVE_ENV.awsWebIdentityTokenFile),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value === undefined)
    .map(([key]) =>
      key === "subjectTokenPath"
        ? `${GCP_LIVE_ENV.subjectTokenFile} or ${GCP_LIVE_ENV.awsWebIdentityTokenFile}`
        : GCP_LIVE_ENV[key as Exclude<keyof typeof required, "subjectTokenPath">],
    );
  if (missing.length > 0) {
    throw new GcpLiveConfigError(missing);
  }
  const projectId = safeProjectId(required.projectId ?? "");
  const billingTable = read(GCP_LIVE_ENV.billingTable);
  if (billingTable) {
    parseBillingTable(billingTable);
  }
  return {
    projectId,
    poolProjectNumber: required.poolProjectNumber ?? "",
    poolId: required.poolId ?? "",
    providerId: required.providerId ?? "",
    serviceAccount: required.serviceAccount ?? "",
    subjectTokenPath: required.subjectTokenPath ?? "",
    ...(billingTable ? { billingTable } : {}),
    jobProjectId: safeProjectId(read(GCP_LIVE_ENV.jobProjectId) ?? projectId),
  };
}

/** Non-secret summary for run records and logs. Checked with assertNoSecrets. */
export function describeGcpLiveConfig(config: GcpLiveConfig) {
  const summary = {
    projectId: config.projectId,
    poolProjectNumber: config.poolProjectNumber,
    poolId: config.poolId,
    providerId: config.providerId,
    serviceAccount: config.serviceAccount,
    subjectSource: "oidc-file",
    billingTable: config.billingTable ?? null,
    jobProjectId: config.jobProjectId,
  };
  assertNoSecrets(summary);
  return summary;
}

export type GcpLiveDeps = {
  fetch?: FetchLike;
  readFile?: (path: string) => Promise<string>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type GcpLiveClients = {
  token: GcpTokenProvider;
  cloudAsset: CloudAssetClient;
  serviceReads: GcpServiceReads;
  recommender: RecommenderClient;
  permissions: GcpPermissionTester;
  bigQuery?: BigQueryExportClient;
  billingExport?: ReturnType<typeof liveBillingExportDetector>;
};

export function gcpLiveClients(config: GcpLiveConfig, deps: GcpLiveDeps = {}): GcpLiveClients {
  const token = gcpFederatedTokenProvider({
    poolProjectNumber: config.poolProjectNumber,
    poolId: config.poolId,
    providerId: config.providerId,
    serviceAccount: config.serviceAccount,
    subjectToken: fileSubjectToken(
      config.subjectTokenPath,
      deps.readFile ?? ((path) => readFile(path, "utf8")),
    ),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const options = {
    token,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  const billing = config.billingTable
    ? {
        bigQuery: liveBigQueryExportClient({
          ...options,
          table: config.billingTable,
          jobProjectId: config.jobProjectId,
        }),
        billingExport: liveBillingExportDetector({
          ...options,
          table: config.billingTable,
          jobProjectId: config.jobProjectId,
        }),
      }
    : {};
  return {
    token,
    cloudAsset: liveCloudAssetClient(options),
    serviceReads: liveServiceReads(options),
    recommender: liveRecommenderClient(options),
    permissions: liveGcpPermissionTester(options),
    ...billing,
  };
}

const DETAIL_TYPES: Array<[string, keyof GcpServiceReads]> = [
  [SQL_ASSET_TYPE, "listSqlInstances"],
  [GKE_ASSET_TYPE, "listGkeClusters"],
  [CERT_ASSET_TYPE, "listCertificates"],
];

function definedProps(asset: CloudAsset): NonNullable<CloudAsset["properties"]> {
  return Object.fromEntries(
    Object.entries(asset.properties ?? {}).filter(([, value]) => value !== null),
  );
}

/**
 * Direct SQL / GKE / Certificate Manager reads override Cloud Asset fields where they have a
 * value. A refused or failed direct read keeps the Cloud Asset copy; a rejected token still throws.
 */
export async function overlayServiceReads(
  assets: readonly CloudAsset[],
  reads: GcpServiceReads,
  projectId: string,
): Promise<CloudAsset[]> {
  let out = [...assets];
  for (const [assetType, method] of DETAIL_TYPES) {
    let direct: CloudAsset[];
    try {
      direct = await reads[method](projectId);
    } catch (error) {
      if (error instanceof GcpAccessDeniedError || error instanceof GcpApiError) {
        continue;
      }
      throw error;
    }
    for (const asset of direct) {
      const index = out.findIndex((item) => item.assetType === assetType && item.id === asset.id);
      if (index === -1) {
        out = [...out, asset];
        continue;
      }
      const current = out[index] as CloudAsset;
      out[index] = {
        ...current,
        labels: Object.keys(current.labels).length > 0 ? current.labels : asset.labels,
        properties: { ...(current.properties ?? {}), ...definedProps(asset) },
      };
    }
  }
  return out;
}

const ZONE = /-[a-z]$/;

export function recommenderZones(assets: readonly CloudAsset[]): string[] {
  return [
    ...new Set(
      assets
        .filter(
          (asset) =>
            asset.assetType === "compute.googleapis.com/Disk" ||
            asset.assetType === "compute.googleapis.com/Instance",
        )
        .map((asset) => asset.location)
        .filter((location) => ZONE.test(location)),
    ),
  ].sort();
}

export type LiveRecommendations =
  | { ok: true; recommendations: Array<GcpRecommendation & { location: string }> }
  | { ok: false; missingRole: true };

export async function harvestLiveRecommendations(
  client: RecommenderClient,
  projectId: string,
  zones: readonly string[],
): Promise<LiveRecommendations> {
  const recommendations: Array<GcpRecommendation & { location: string }> = [];
  try {
    for (const location of zones) {
      for (const recommenderId of IDLE_RECOMMENDERS) {
        const rows = await client.list({ projectId, location, recommenderId });
        recommendations.push(...rows.map((row) => ({ ...row, location })));
      }
    }
  } catch (error) {
    if (error instanceof MissingRecommenderRoleError) {
      return { ok: false, missingRole: true };
    }
    throw error;
  }
  return { ok: true, recommendations };
}

export function recommendationAsset(row: GcpRecommendation & { location: string }): CloudAsset {
  return {
    id: row.recommendationId,
    name: `//recommender.googleapis.com/projects/${row.projectId}/locations/${row.location}/recommendations/${row.recommendationId}`,
    assetType: REC_TYPE,
    project: row.projectId,
    displayName: row.recommendationId,
    location: row.location,
    labels: {},
    properties: {
      recommenderId: row.recommenderId,
      resourceName: row.resourceName,
      subtype: row.subtype,
      ...(row.savingsMin === undefined ? {} : { savingsMin: row.savingsMin }),
      ...(row.savingsMax === undefined ? {} : { savingsMax: row.savingsMax }),
      ...(row.currency === undefined ? {} : { currency: row.currency }),
    },
  };
}

export type LiveGcpHarvestClients = Pick<
  GcpLiveClients,
  "cloudAsset" | "serviceReads" | "recommender"
>;

export function liveGcpHarvester(clients: LiveGcpHarvestClients, clock?: Clock): Harvester {
  return {
    async harvest(input) {
      const projectId = safeProjectId(input.subscriptionId);
      const observedAt = clock ? clock() : new Date().toISOString();
      const cai = await harvestCloudAssets({
        client: clients.cloudAsset,
        projectId,
        settings: input.settings,
        observedAt,
      });
      let assets = cai.assets;
      let coverage = cai.coverage;
      if (cai.ok) {
        assets = await overlayServiceReads(assets, clients.serviceReads, projectId);
        const recs = await harvestLiveRecommendations(
          clients.recommender,
          projectId,
          recommenderZones(assets),
        );
        if (recs.ok) {
          assets = [...assets, ...recs.recommendations.map(recommendationAsset)];
        } else {
          coverage = applyCoverageResults(coverage, [
            {
              subscriptionOrProject: projectId,
              checkId: GCP_IDLE_RECS,
              state: "unassessed",
              causeId: "missing_role",
              closer: RECOMMENDER_ROLE_CLOSER,
            },
          ]);
        }
      }
      return {
        inventory: inventoryFromAssets(assets, input.settings.ownerTagKey, observedAt),
        coverage,
        coveredScopes: coverage
          .filter((entry) => entry.state === "assessed")
          .map((entry) => entry.id),
        facts: factsFromAssets(assets),
      };
    },
  };
}

/** The fixture harvester unless live GCP is explicitly configured. CI sets nothing, so stays on fixtures. */
export function selectGcpHarvester(
  env: NodeJS.Dict<string> = process.env,
  clock?: Clock,
  deps: GcpLiveDeps = {},
): Harvester {
  const config = gcpLiveConfigFromEnv(env);
  return config
    ? liveGcpHarvester(gcpLiveClients(config, deps), clock)
    : providerFor("gcp").harvester(clock);
}
