import type { Clock } from "./clock.js";
import {
  azureLiveConfigFromEnv,
  azureLiveFromEnv,
  AzureLiveConfigError,
} from "./azure-live-harvest.js";
import { isTenantId } from "./azure-federated.js";
import type { FetchLike } from "./azure-live.js";
import { errorDetail, type ErrorDetail } from "./error-detail.js";
import {
  gcpLiveClients,
  gcpLiveConfigFromEnv,
  GcpLiveConfigError,
  liveGcpHarvester,
} from "./gcp-live-harvester.js";
import type { LogSink } from "./observability.js";
import type { Harvester } from "./providers/types.js";
import type { OrgRepository } from "./repository.js";
import {
  unconfiguredHarvester,
  type HarvestClientSource,
  type ScanHarvestClients,
} from "./scans.js";
import type { Cloud } from "@farside/scan-contracts";

/**
 * Live scanning from the local CLI. Off unless the same switches the backend uses are set, so with none of them the CLI
 * behaves exactly as before. Azure also needs the tenant, because the CLI has no stored connection to read it from.
 */
export const CLI_AZURE_TENANT_ENV = "FARSIDE_AZURE_TENANT_ID";

export class CliLiveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliLiveConfigError";
  }
}

export type CliLive = {
  harvester: Harvester;
  clients: ScanHarvestClients | HarvestClientSource;
  /** Roles the scan identity holds on the scope, when the cloud can list them. Undefined when it cannot. */
  grantedRoles?: readonly string[];
};

/** True when live scanning is switched on for this cloud, whether or not the rest of its configuration is valid. */
export function liveRequested(cloud: Cloud, env: NodeJS.Dict<string>): boolean {
  return cloud === "gcp" ? env.FARSIDE_GCP_LIVE === "1" : env.FARSIDE_AZURE_LIVE === "1";
}

export type CliLiveInput = {
  cloud: Cloud;
  scope: string;
  env: NodeJS.Dict<string>;
  store: OrgRepository;
  clock: Clock;
  orgId: string;
  /** Test seams. Production uses the real network and files. */
  fetch?: FetchLike;
  readFile?: (path: string) => Promise<string>;
  log?: (fields: Record<string, unknown>, message: string) => void;
};

/** Null when live is off. Throws CliLiveConfigError (a fixed, safe message) when it is on but cannot be used. */
export async function cliLiveSources(input: CliLiveInput): Promise<CliLive | null> {
  if (!liveRequested(input.cloud, input.env)) {
    return null;
  }
  try {
    return input.cloud === "gcp" ? gcpSources(input) : await azureSources(input);
  } catch (error) {
    if (error instanceof AzureLiveConfigError || error instanceof GcpLiveConfigError) {
      throw new CliLiveConfigError(error.message);
    }
    throw error;
  }
}

async function azureSources(input: CliLiveInput): Promise<CliLive | null> {
  if (!azureLiveConfigFromEnv(input.env)) {
    return null;
  }
  const tenantId = input.env[CLI_AZURE_TENANT_ENV]?.trim() ?? "";
  if (!isTenantId(tenantId)) {
    throw new CliLiveConfigError(
      `FARSIDE_AZURE_LIVE=1 also needs ${CLI_AZURE_TENANT_ENV} (the tenant GUID or domain)`,
    );
  }
  const wiring = azureLiveFromEnv(input.env, {
    store: input.store,
    fallback: unconfiguredHarvester(),
    clock: input.clock,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  if (!wiring) {
    return null;
  }
  const grantedRoles = await wiring.roleLister.list({
    tenantId,
    subscriptionId: input.scope,
    cloud: "azure",
  });
  await input.store.putConnection(input.orgId, {
    tenantId,
    subscriptionId: input.scope,
    cloud: "azure",
    grantedRoles,
  });
  return { harvester: wiring.harvester, clients: wiring.harvestClients, grantedRoles };
}

function gcpSources(input: CliLiveInput): CliLive | null {
  const config = gcpLiveConfigFromEnv(input.env);
  if (!config) {
    return null;
  }
  // The live identity is one project's. Scanning any other scope with it would read the wrong project.
  if (input.scope !== config.projectId) {
    throw new CliLiveConfigError(
      `--scope must be the configured project (${config.projectId}); live GCP reads only that project`,
    );
  }
  const clients = gcpLiveClients(config, {
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.readFile ? { readFile: input.readFile } : {}),
    now: () => new Date(input.clock()),
  });
  return {
    harvester: liveGcpHarvester(clients, input.clock, input.log),
    clients: {},
  };
}

/** The error and each cause behind it, as safe fields only (name, status, code, step). Never a message, URL or body. */
export function causeChain(error: unknown, depth = 6): ErrorDetail[] {
  const chain: ErrorDetail[] = [];
  let current: unknown = error;
  for (let index = 0; index < depth && current !== undefined && current !== null; index += 1) {
    chain.push(errorDetail(current));
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/** A log sink for the CLI: prints a failed scan's error code and cause chain to the writer, and nothing else. */
export function failureSink(write: (fields: Record<string, unknown>) => void): LogSink {
  return {
    info: () => undefined,
    error: (fields) => {
      const { event, errorCode, err } = fields as {
        event?: string;
        errorCode?: string;
        err?: unknown;
      };
      if (event === "scan.failed" || event === "scan.execution_failed") {
        write({ failed: errorCode ?? event, cause: causeChain(err) });
      }
    },
  };
}
