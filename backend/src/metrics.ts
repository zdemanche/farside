import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { resourceUriFor, type ResourceFacts } from "./facts.js";
import type { GroundTruthItem, GroundTruthManifest } from "./inventory.js";
import { rejectUnconfigured } from "./providers/unconfigured.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };

export const IDLE_LOAD_BALANCERS = "azure-waste-idle-load-balancers";
export const IDLE_NAT_GATEWAYS = "azure-waste-idle-nat-gateways";
export const METRIC_CHECK_IDS = [IDLE_LOAD_BALANCERS, IDLE_NAT_GATEWAYS] as const;
export const METRIC_RESOURCE_TYPES = [
  "Microsoft.Network/loadBalancers",
  "Microsoft.Network/natGateways",
] as const;
export const METRIC_WINDOW = "7d";
export const MONITORING_ROLE_CLOSER = "Monitoring Reader on the subscription that owns the resource";

export type MetricAggregate = {
  resourceUri: string;
  metricName: "ByteCount";
  window: string;
  aggregation: "Total";
  value: number;
};

export type MetricsClient = {
  query: (input: {
    subscriptionId: string;
    resourceUri: string;
    metricName: "ByteCount";
    window: string;
  }) => Promise<MetricAggregate>;
};

export class MissingMonitoringRoleError extends Error {
  constructor() {
    super("Monitoring Reader is missing");
    this.name = "MissingMonitoringRoleError";
  }
}

const MANIFEST = docAzureGroundTruth as GroundTruthManifest;

function metricItems(manifest: GroundTruthManifest = MANIFEST): GroundTruthItem[] {
  return manifest.items.filter((item) =>
    (METRIC_RESOURCE_TYPES as readonly string[]).includes(item.type),
  );
}

export function fixtureMetricsClient(manifest: GroundTruthManifest = MANIFEST): MetricsClient {
  const byUri = new Map(
    metricItems(manifest).map((item) => [resourceUriFor(item), item] as const),
  );
  return {
    async query(input) {
      const item = byUri.get(input.resourceUri);
      const value = typeof item?.properties?.byteCount === "number" ? item.properties.byteCount : 0;
      return {
        resourceUri: input.resourceUri,
        metricName: "ByteCount",
        window: input.window,
        aggregation: "Total",
        value,
      };
    },
  };
}

export function missingMonitoringRoleClient(): MetricsClient {
  return {
    async query() {
      throw new MissingMonitoringRoleError();
    },
  };
}

export function unconfiguredMetricsClient(): MetricsClient {
  return {
    async query() {
      rejectUnconfigured();
    },
  };
}

export function missingRoleCoverage(subscriptionId: string): CoverageEntry[] {
  return METRIC_CHECK_IDS.map((checkId) =>
    recordCoverageScope({
      subscriptionOrProject: subscriptionId,
      checkId,
      state: "unassessed",
      causeId: "missing_role",
      closer: MONITORING_ROLE_CLOSER,
    }),
  );
}

export function applyMetricFacts(
  facts: readonly ResourceFacts[],
  aggregates: readonly MetricAggregate[],
): ResourceFacts[] {
  const byUri = new Map(aggregates.map((row) => [row.resourceUri, row]));
  return facts.map((fact) => {
    const metric = byUri.get(fact.resourceUri);
    if (!metric) {
      return fact;
    }
    return {
      resourceUri: fact.resourceUri,
      fields: {
        ...fact.fields,
        metricWindow: metric.window,
        byteCount: metric.value,
      },
    };
  });
}

export type MetricsHarvest =
  | { ok: true; aggregates: MetricAggregate[]; facts: ResourceFacts[]; coverage: CoverageEntry[] }
  | { ok: false; reason: "missing_role"; coverage: CoverageEntry[] };

export async function harvestMetrics(input: {
  client: MetricsClient;
  subscriptionId: string;
  facts: readonly ResourceFacts[];
  window?: string;
}): Promise<MetricsHarvest> {
  const window = input.window ?? METRIC_WINDOW;
  const targets = input.facts.filter((fact) =>
    METRIC_RESOURCE_TYPES.some((type) => fact.resourceUri.includes(`/providers/${type}/`)),
  );
  const aggregates: MetricAggregate[] = [];
  try {
    for (const fact of targets) {
      aggregates.push(
        await input.client.query({
          subscriptionId: input.subscriptionId,
          resourceUri: fact.resourceUri,
          metricName: "ByteCount",
          window,
        }),
      );
    }
  } catch (error) {
    if (error instanceof MissingMonitoringRoleError) {
      return { ok: false, reason: "missing_role", coverage: missingRoleCoverage(input.subscriptionId) };
    }
    throw error;
  }
  return {
    ok: true,
    aggregates,
    facts: applyMetricFacts(input.facts, aggregates),
    coverage: METRIC_CHECK_IDS.map((checkId) =>
      recordCoverageScope({
        subscriptionOrProject: input.subscriptionId,
        checkId,
        state: "assessed",
      }),
    ),
  };
}
