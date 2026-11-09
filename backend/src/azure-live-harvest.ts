import {
  AzureAuthError,
  liveBudgetClient,
  liveCostClient,
  liveMetricsClient,
  type ArmOptions,
  type FetchLike,
  type TokenProvider,
} from "./azure-live.js";
import {
  ASSERTION_FILE_ENV,
  assertionFileFromEnv,
  federatedTokenProviders,
  fileAssertionSource,
  isGuid,
  type AssertionSource,
} from "./azure-federated.js";
import { liveProtectedItems, liveResourceGraphClient, liveRoleLister } from "./azure-live-graph.js";
import { systemClock, type Clock } from "./clock.js";
import { applyCoverageResults, type CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import {
  METRIC_RESOURCE_TYPES,
  METRIC_WINDOW,
  MissingMonitoringRoleError,
  applyMetricFacts,
  missingRoleCoverage,
  type MetricAggregate,
} from "./metrics.js";
import type { HarvestClientSource, HarvestResult, Harvester } from "./providers/types.js";
import type { OrgRepository } from "./repository.js";
import { harvestResourceGraph } from "./resource-graph.js";
import type { RoleLister } from "./role-probe.js";
import { ScanFailedError } from "./scans.js";
import type { OrgSettings } from "./settings.js";

/**
 * Live Azure harvest wiring (#58, #73, #76). Off unless `FARSIDE_AZURE_LIVE=1` and the app
 * client id and an assertion file are set. Each scan reads the connection's tenant, exchanges
 * the runtime's OIDC token for an ARM token in that tenant, and runs Resource Graph, backup,
 * metrics, cost, and budget reads. Built and tested against mocked fetch only.
 */
export const AZURE_LIVE_ENV = "FARSIDE_AZURE_LIVE";
export const AZURE_CLIENT_ID_ENV = "FARSIDE_AZURE_CLIENT_ID";

const BACKUP_TYPES = ["microsoft.compute/virtualmachines", "microsoft.sql/servers/databases"];

export class AzureLiveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureLiveConfigError";
  }
}

export type AzureLiveConfig = { clientId: string; assertionFile: string };

/** Null when live Azure is off. Throws when it is on but incomplete, or a secret is present. */
export function azureLiveConfigFromEnv(env: NodeJS.Dict<string>): AzureLiveConfig | null {
  if (env[AZURE_LIVE_ENV] !== "1") {
    return null;
  }
  if (typeof env.AZURE_CLIENT_SECRET === "string" && env.AZURE_CLIENT_SECRET.length > 0) {
    throw new AzureLiveConfigError("client secrets are refused; live Azure uses federated credentials only");
  }
  const clientId = env[AZURE_CLIENT_ID_ENV] ?? "";
  const assertionFile = assertionFileFromEnv(env);
  const missing = [
    ...(isGuid(clientId) ? [] : [`${AZURE_CLIENT_ID_ENV} (app registration client id GUID)`]),
    ...(assertionFile ? [] : [ASSERTION_FILE_ENV.join(" or ")]),
  ];
  if (missing.length > 0 || !assertionFile) {
    throw new AzureLiveConfigError(`${AZURE_LIVE_ENV}=1 also needs ${missing.join(", ")}`);
  }
  return { clientId, assertionFile };
}

export type TenantResolver = (orgId: string, subscriptionId: string) => Promise<string | null>;

/** The tenant of the org's Azure connection for that subscription, or null if none. */
export function connectionTenantResolver(store: OrgRepository): TenantResolver {
  return async (orgId, subscriptionId) => {
    const { connections } = await store.read(orgId, "connections");
    const target = subscriptionId.toLowerCase();
    return (
      connections.find((item) => item.cloud === "azure" && item.subscriptionId.toLowerCase() === target)
        ?.tenantId ?? null
    );
  };
}

export type LiveAzureDeps = {
  tokenFor: (tenantId: string) => TokenProvider;
  resolveTenant: TenantResolver;
  fetch?: FetchLike;
  clock?: Clock;
};

function armFor(deps: LiveAzureDeps, tenantId: string): ArmOptions {
  const clock = deps.clock ?? systemClock;
  return {
    token: deps.tokenFor(tenantId),
    now: () => new Date(clock()),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
}

function hasType(fact: ResourceFacts, types: readonly string[]): boolean {
  const uri = fact.resourceUri.toLowerCase();
  return types.some((type) => uri.includes(`/providers/${type.toLowerCase()}/`));
}

/** Backup state from protected items. Unreadable leaves `protected` unset, so checks say undetermined. */
async function withBackupFacts(arm: ArmOptions, subscriptionId: string, facts: ResourceFacts[]) {
  let items: Map<string, string>;
  try {
    items = await liveProtectedItems(arm, subscriptionId);
  } catch (error) {
    if (error instanceof AzureAuthError) {
      throw error;
    }
    return facts;
  }
  return facts.map((fact) => {
    if (!hasType(fact, BACKUP_TYPES)) {
      return fact;
    }
    const vaultId = items.get(fact.resourceUri.toLowerCase());
    return {
      resourceUri: fact.resourceUri,
      fields: { ...fact.fields, protected: vaultId !== undefined, ...(vaultId ? { vaultId } : {}) },
    };
  });
}

/** ByteCount per LB/NAT. A metric with no data is skipped (undetermined), never zero traffic. */
async function withMetricFacts(arm: ArmOptions, subscriptionId: string, facts: ResourceFacts[]) {
  const client = liveMetricsClient(arm);
  const aggregates: MetricAggregate[] = [];
  for (const fact of facts.filter((row) => hasType(row, METRIC_RESOURCE_TYPES))) {
    try {
      aggregates.push(
        await client.query({ subscriptionId, resourceUri: fact.resourceUri, metricName: "ByteCount", window: METRIC_WINDOW }),
      );
    } catch (error) {
      if (error instanceof MissingMonitoringRoleError) {
        return { facts, coverage: missingRoleCoverage(subscriptionId) };
      }
      if (error instanceof AzureAuthError) {
        throw error;
      }
      // MetricUnavailableError or a failed call: leave byteCount unset for this resource.
    }
  }
  return { facts: applyMetricFacts(facts, aggregates), coverage: [] as CoverageEntry[] };
}

export async function harvestLiveSubscription(input: {
  arm: ArmOptions;
  subscriptionId: string;
  settings: OrgSettings;
  observedAt: string;
}): Promise<HarvestResult> {
  const graph = await harvestResourceGraph({
    client: liveResourceGraphClient(input.arm),
    subscriptionId: input.subscriptionId,
    settings: input.settings,
    observedAt: input.observedAt,
  });
  if (!graph.ok) {
    throw new ScanFailedError(`resource graph ${graph.reason ?? "failed_call"}`, []);
  }
  const backed = await withBackupFacts(input.arm, input.subscriptionId, graph.facts);
  const metrics = await withMetricFacts(input.arm, input.subscriptionId, backed);
  const coverage = applyCoverageResults(graph.coverage, metrics.coverage);
  return {
    inventory: graph.inventory,
    facts: metrics.facts,
    coverage,
    coveredScopes: coverage.filter((entry) => entry.state === "assessed").map((entry) => entry.id),
  };
}

/** Azure connections harvest live; anything else (no connection, GCP) goes to `fallback`. */
export function liveAzureHarvester(deps: LiveAzureDeps & { fallback: Harvester }): Harvester {
  const clock = deps.clock ?? systemClock;
  return {
    async harvest(input) {
      const tenantId = await deps.resolveTenant(input.orgId, input.subscriptionId);
      if (!tenantId) {
        return deps.fallback.harvest(input);
      }
      return harvestLiveSubscription({
        arm: armFor(deps, tenantId),
        subscriptionId: input.subscriptionId,
        settings: input.settings,
        observedAt: clock(),
      });
    },
  };
}

/** Cost and budget clients for the scan's subscription, with that tenant's token. */
export function liveAzureClients(deps: LiveAzureDeps): HarvestClientSource {
  return async ({ orgId, subscriptionId }) => {
    const tenantId = await deps.resolveTenant(orgId, subscriptionId);
    if (!tenantId) {
      return {};
    }
    const arm = armFor(deps, tenantId);
    return {
      costClient: liveCostClient(arm),
      budgetClient: liveBudgetClient({ ...arm, subscriptionIds: [subscriptionId] }),
    };
  };
}

export type AzureLiveWiring = {
  harvester: Harvester;
  harvestClients: HarvestClientSource;
  roleLister: RoleLister;
  tokenFor: (tenantId: string) => TokenProvider;
};

export function azureLiveWiring(
  config: { clientId: string; assertion: AssertionSource },
  options: { store: OrgRepository; fallback: Harvester; fetch?: FetchLike; clock?: Clock },
): AzureLiveWiring {
  const clock = options.clock ?? systemClock;
  const tokenFor = federatedTokenProviders({
    clientId: config.clientId,
    assertion: config.assertion,
    now: () => Date.parse(clock()),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const deps: LiveAzureDeps = {
    tokenFor,
    resolveTenant: connectionTenantResolver(options.store),
    clock,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  return {
    harvester: liveAzureHarvester({ ...deps, fallback: options.fallback }),
    harvestClients: liveAzureClients(deps),
    roleLister: liveRoleLister({ tokenFor, ...(options.fetch ? { fetch: options.fetch } : {}) }),
    tokenFor,
  };
}

/** The entry points call this. Null (fixture/unconfigured path) unless live Azure is switched on. */
export function azureLiveFromEnv(
  env: NodeJS.Dict<string>,
  options: { store: OrgRepository; fallback: Harvester; fetch?: FetchLike; clock?: Clock },
): AzureLiveWiring | null {
  const config = azureLiveConfigFromEnv(env);
  if (!config) {
    return null;
  }
  return azureLiveWiring({ clientId: config.clientId, assertion: fileAssertionSource(config.assertionFile) }, options);
}
