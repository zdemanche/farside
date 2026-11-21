import type { Clock } from "./clock.js";
import type { Finding } from "@farside/scan-contracts";
import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { CUD_EXPORT_CLOSER, GCP_COMMITTED_USE } from "./gcp-commitments.js";
import type { StoredIssue } from "./issues.js";
import {
  azureLiveConfigFromEnv,
  azureLiveFromEnv,
  AzureLiveConfigError,
} from "./azure-live-harvest.js";
import { isGuid, isTenantId } from "./azure-federated.js";
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
  ScanFailedError,
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

/** What a scan saves. Live GCP adjusts it so the saved result says only what was really assessed. */
export type ScanOutput = { findings: Finding[]; issues: StoredIssue[]; coverage: CoverageEntry[] };

export type CliLive = {
  harvester: Harvester;
  clients: ScanHarvestClients | HarvestClientSource;
  /** Roles the scan identity holds on the scope, when the cloud can list them. Undefined when it cannot. */
  grantedRoles?: readonly string[];
  /**
   * Returns the output to save, and the coverage counts to print. `before` is what the workspace held before this scan.
   * Absent when the scan result needs no adjusting.
   */
  finalize?: (
    output: ScanOutput,
    scope: string,
    before: Pick<ScanOutput, "findings" | "issues">,
  ) => {
    output: ScanOutput;
    summary: { assessed: number; unassessed: number; undetermined: number };
  };
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
  if (!isGuid(input.scope)) {
    throw new CliLiveConfigError("--scope must be the Azure subscription id (a GUID)");
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

/** Checks whose registered implementation reads fixture data, so they must not report on a real project. */
const FIXTURE_ONLY_GCP_CHECKS: ReadonlyMap<string, string> = new Map([
  [GCP_COMMITTED_USE, CUD_EXPORT_CLOSER],
]);

/** A harvest failure that is a real cause, not just "this check is not run by the harvest". */
function isFailure(entry: CoverageEntry): boolean {
  return entry.state !== "assessed" && entry.causeId !== undefined && entry.causeId !== "not_run";
}

function countStates(coverage: readonly CoverageEntry[], scope: string) {
  const own = coverage.filter((entry) => entry.subscriptionOrProject === scope);
  const count = (state: CoverageEntry["state"]) =>
    own.filter((entry) => entry.state === state).length;
  return {
    assessed: count("assessed"),
    unassessed: count("unassessed"),
    undetermined: count("undetermined"),
  };
}

function gcpSources(input: CliLiveInput): CliLive | null {
  let config;
  try {
    config = gcpLiveConfigFromEnv(input.env);
  } catch (error) {
    if (error instanceof GcpLiveConfigError) {
      throw error;
    }
    throw new CliLiveConfigError(
      "the GCP live settings are invalid: check FARSIDE_GCP_PROJECT_ID and FARSIDE_GCP_BILLING_EXPORT_TABLE",
    );
  }
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
  let failedRead: ErrorDetail | null = null;
  let harvestCoverage: CoverageEntry[] = [];
  const inner = liveGcpHarvester(clients, input.clock, (fields, message) => {
    if (fields.event === "gcp.harvest.failed") {
      failedRead = {
        name: String(fields.name ?? "Error"),
        ...(typeof fields.status === "number" ? { status: fields.status } : {}),
        ...(typeof fields.code === "string" ? { code: fields.code } : {}),
        ...(typeof fields.step === "string" ? { step: fields.step } : {}),
      };
    }
    input.log?.(fields, message);
  });
  const harvester: Harvester = {
    async harvest(harvestInput) {
      const result = await inner.harvest(harvestInput);
      if (failedRead) {
        // The harvest reads as an empty, undetermined project. Saved as a scan it would show nothing and close every
        // earlier issue, so fail the scan and keep its cause instead.
        throw new ScanFailedError("gcp cloud asset read failed", [], {
          cause: Object.assign(new Error("gcp read failed"), failedRead),
        });
      }
      harvestCoverage = result.coverage.filter(isFailure);
      return result;
    },
  };
  return {
    harvester,
    clients: {},
    finalize(output, scope, before) {
      // Fixture-only checks never report on a real project, so nothing of theirs is kept. Harvest-failure checks could not
      // be assessed this scan, so what an earlier scan found for them is kept exactly as it was, not closed and not dropped.
      const unassessed = new Map<string, CoverageEntry>();
      for (const entry of harvestCoverage) {
        unassessed.set(entry.checkId, entry);
      }
      const adjust = new Map(unassessed);
      for (const [checkId, closer] of FIXTURE_ONLY_GCP_CHECKS) {
        adjust.set(
          checkId,
          recordCoverageScope({
            subscriptionOrProject: scope,
            checkId,
            state: "unassessed",
            causeId: "not_run",
            closer,
          }),
        );
      }
      // Only rows of the scanned project are touched. Another project in the same workspace keeps everything it had.
      const ownFinding = (finding: Finding) => finding.scope.subscriptionOrProject === scope;
      const ownIssue = (issue: StoredIssue) => issue.subscriptionOrProject === scope;
      const dropFinding = (finding: Finding) => ownFinding(finding) && adjust.has(finding.checkId);
      const dropIssue = (issue: StoredIssue) => ownIssue(issue) && adjust.has(issue.checkId);
      const keptFindings = before.findings.filter(
        (finding) => ownFinding(finding) && unassessed.has(finding.checkId),
      );
      // What an earlier scan saved for a check this scan could not assess is kept, but it is no longer confirmed: the same
      // change applyScanToIssues makes to an issue whose scope was not covered. A closed issue stays closed. Left open and
      // assessed, the report would add its savings to "Nameable waste" next to the check it lists as unassessed.
      const keptIssues = before.issues
        .filter((issue) => ownIssue(issue) && unassessed.has(issue.checkId))
        .map((issue): StoredIssue => {
          if (issue.status === "closed") {
            return issue;
          }
          const entry = unassessed.get(issue.checkId);
          const { closingScanId: _closing, ...rest } = issue;
          return {
            ...rest,
            status: "not_confirmed",
            coverage: entry?.state ?? "unassessed",
            notConfirmedReason:
              entry?.reason ??
              "This scan did not cover the issue scope, so Farside could not confirm it.",
          };
        });
      const coverage = [
        ...output.coverage.filter(
          (entry) => !(entry.subscriptionOrProject === scope && adjust.has(entry.checkId)),
        ),
        ...adjust.values(),
      ];
      const adjusted: ScanOutput = {
        findings: [...output.findings.filter((finding) => !dropFinding(finding)), ...keptFindings],
        issues: [...output.issues.filter((issue) => !dropIssue(issue)), ...keptIssues],
        coverage,
      };
      return { output: adjusted, summary: countStates(coverage, scope) };
    },
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
