import { randomUUID } from "node:crypto";
import type { Cloud, Finding, Inventory } from "@farside/scan-contracts";
import { abortable } from "./abortable.js";
import { runChecks } from "./checks.js";
import { systemClock, type Clock } from "./clock.js";
import { applyCoverageResults, type CoverageEntry, type CoverageState } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import { applyScanToIssues } from "./issues.js";
import { DEFAULT_CLOUD, providerFor, registeredCheckIds } from "./providers/index.js";
import type { HarvestResult, Harvester, PostHarvest, ScanHarvestClients } from "./providers/types.js";
import { fixtureHarvester } from "./providers/fixture-harvester.js";
import { PROVIDER_NOT_CONFIGURED, ProviderNotConfiguredError, rejectUnconfigured } from "./providers/unconfigured.js";
import { scopeOf } from "./scope.js";
import { silentLog, type LogSink } from "./observability.js";
import { addHours, DEFAULT_SCAN_TIMEOUT_MS, RETRY_DELAY_HOURS } from "./scheduler.js";
import type { MemoryStore } from "./store.js";
import { asMutable, type DeepReadonly } from "./readonly.js";

// "cancelled" is stored so a cancelled job frees its subscription, but the API never returns it
export type ScanStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ScanCheckOutcome = {
  checkId: string;
  state: CoverageState;
  reason?: string;
  closer?: string;
};

export type ScanCoverageSummary = {
  assessed: number;
  unassessed: number;
  undetermined: number;
};

export const EMPTY_COVERAGE_SUMMARY: ScanCoverageSummary = {
  assessed: 0,
  unassessed: 0,
  undetermined: 0,
};

export type ScanJob = {
  id: string;
  orgId: string;
  subscriptionId: string;
  cloud: Cloud | null;
  actor: "user" | "system";
  status: ScanStatus;
  complete: boolean;
  coveredScopes: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  errorId?: string;
  durationMs: number | null;
  coverageSummary: ScanCoverageSummary;
  checks: ScanCheckOutcome[];
};

export type ScanView = DeepReadonly<ScanJob> & { current: boolean };

const FAILED_BEFORE_CHECK = "Scan failed before this check ran.";

export function durationMsFrom(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) {
    return null;
  }
  return Date.parse(finishedAt) - Date.parse(startedAt);
}

export function coverageSummaryFrom(checks: readonly ScanCheckOutcome[]): ScanCoverageSummary {
  const coverageSummary: ScanCoverageSummary = { assessed: 0, unassessed: 0, undetermined: 0 };
  for (const check of checks) {
    coverageSummary[check.state] += 1;
  }
  return coverageSummary;
}

export function checksFromCoverage(
  coverage: readonly CoverageEntry[],
  subscriptionId: string,
): ScanCheckOutcome[] {
  return coverage
    .filter((entry) => entry.subscriptionOrProject === subscriptionId)
    .map((entry) => {
      const outcome: ScanCheckOutcome = { checkId: entry.checkId, state: entry.state };
      if (entry.reason) {
        outcome.reason = entry.reason;
      }
      if (entry.closer) {
        outcome.closer = entry.closer;
      }
      return outcome;
    });
}

export function checksFromFailure(
  coveredScopes: string[],
  subscriptionId: string,
  cloud: Cloud = DEFAULT_CLOUD,
): ScanCheckOutcome[] {
  const covered = new Set(coveredScopes);
  return providerFor(cloud).launchCheckIds.map((checkId) => {
    if (covered.has(`${subscriptionId}:${checkId}`)) {
      return { checkId, state: "assessed" as const };
    }
    return { checkId, state: "unassessed" as const, reason: FAILED_BEFORE_CHECK };
  });
}

export function toScanView(job: DeepReadonly<ScanJob>, current: boolean): ScanView {
  return {
    ...job,
    durationMs: durationMsFrom(job.startedAt, job.finishedAt),
    current: current && job.status === "succeeded" && job.complete,
  };
}

function currentScanId(jobs: readonly DeepReadonly<ScanJob>[]): string | undefined {
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    if (job && job.status === "succeeded" && job.complete) {
      return job.id;
    }
  }
  return undefined;
}

export function toScanViews(jobs: readonly DeepReadonly<ScanJob>[]): ScanView[] {
  const currentId = currentScanId(jobs);
  return jobs.filter((job) => job.status !== "cancelled").map((job) => toScanView(job, job.id === currentId));
}

export function findScanView(jobs: readonly DeepReadonly<ScanJob>[], scanId: string): ScanView | undefined {
  const job = jobs.find((candidate) => candidate.id === scanId);
  return job && job.status !== "cancelled" ? toScanView(job, job.id === currentScanId(jobs)) : undefined;
}

export type { HarvestResult, Harvester, ScanHarvestClients };

export { fixtureHarvester };

export function mergeScanFindings(
  existing: readonly Finding[],
  next: readonly Finding[],
  replaceCheckIds: ReadonlySet<string>,
  subscriptionId: string,
): Finding[] {
  const target = subscriptionId.toLowerCase();
  return [
    ...existing.filter(
      (finding) =>
        !(
          replaceCheckIds.has(finding.checkId) &&
          finding.scope.subscriptionOrProject.toLowerCase() === target
        ),
    ),
    ...next,
  ];
}

export function mergeScanCoverage(
  existing: readonly CoverageEntry[],
  next: readonly CoverageEntry[],
  replaceCheckIds: ReadonlySet<string>,
  subscriptionId: string,
): CoverageEntry[] {
  const target = subscriptionId.toLowerCase();
  const kept = existing.filter(
    (entry) =>
      !(replaceCheckIds.has(entry.checkId) && entry.subscriptionOrProject.toLowerCase() === target),
  );
  return applyCoverageResults(kept, next);
}

function failureCode(error: unknown, harvesting: boolean): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "harvest_timeout";
  }
  return error instanceof ScanFailedError || harvesting ? "harvest_failed" : "scan_failed";
}

function scannedScopes(inventory: Inventory, subscriptionId: string): Set<string> {
  return new Set(
    [subscriptionId, ...inventory.resources.map((resource) => scopeOf(inventory.cloud, resource.resourceUri))]
      .filter((key) => key.length > 0)
      .map((key) => key.toLowerCase()),
  );
}

function replacedByScan(scopes: Set<string>, key: string, incomingHasEmptyKey: boolean): boolean {
  return key.length === 0 ? incomingHasEmptyKey : scopes.has(key.toLowerCase());
}

export function mergeScanInventory(
  existing: Inventory | undefined,
  next: Inventory,
  subscriptionId: string,
): Inventory {
  if (!existing) {
    return next;
  }
  const scopes = scannedScopes(next, subscriptionId);
  const incomingHasEmptyKey = next.resources.some((resource) => scopeOf(next.cloud, resource.resourceUri) === "");
  return {
    ...next,
    resources: [
      ...existing.resources.filter(
        (resource) =>
          !replacedByScan(scopes, scopeOf(existing.cloud, resource.resourceUri), incomingHasEmptyKey),
      ),
      ...next.resources,
    ],
  };
}

export function mergeScanFacts(
  existing: readonly ResourceFacts[],
  next: readonly ResourceFacts[],
  inventory: Inventory,
  subscriptionId: string,
): ResourceFacts[] {
  const scopes = scannedScopes(inventory, subscriptionId);
  const incomingHasEmptyKey = next.some((row) => scopeOf(inventory.cloud, row.resourceUri) === "");
  return [
    ...existing.filter(
      (row) => !replacedByScan(scopes, scopeOf(inventory.cloud, row.resourceUri), incomingHasEmptyKey),
    ),
    ...next,
  ];
}

export class ScanFailedError extends Error {
  constructor(
    message: string,
    readonly coveredScopes: string[],
  ) {
    super(message);
    this.name = "ScanFailedError";
  }
}

export function defaultHarvester(clock?: Clock): Harvester {
  return providerFor(DEFAULT_CLOUD).harvester(clock);
}

export function unconfiguredHarvester(): Harvester {
  return {
    async harvest() {
      rejectUnconfigured();
    },
  };
}

const NO_POST_HARVEST: PostHarvest = { apply: (outputs) => outputs };

export class ScanRunner {
  #queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: MemoryStore,
    private readonly harvester: Harvester,
    private readonly harvestClients: ScanHarvestClients = {},
    private readonly clock: Clock = systemClock,
    private readonly log: LogSink = silentLog,
    readonly scanTimeoutMs: number = DEFAULT_SCAN_TIMEOUT_MS,
  ) {}

  start(input: { orgId: string; subscriptionId: string; actor: "user" | "system" }): {
    job: ScanJob;
    started: boolean;
    done: Promise<ScanJob>;
  } {
    this.expireStaleScans(input.orgId, this.clock());
    const existing = this.store.runningScan(input.orgId, input.subscriptionId);
    if (existing) {
      return { job: existing, started: false, done: Promise.resolve(existing) };
    }
    const job = this.store.putJob({
      orgId: input.orgId,
      subscriptionId: input.subscriptionId,
      cloud: null,
      actor: input.actor,
      status: "queued",
      complete: false,
      coveredScopes: [],
      createdAt: this.clock(),
      startedAt: null,
      finishedAt: null,
      error: null,
      durationMs: null,
      coverageSummary: EMPTY_COVERAGE_SUMMARY,
      checks: [],
    });
    const connected = this.store.isConnected(input.orgId, input.subscriptionId);
    const tail = this.#queues.get(input.orgId);
    if (tail) {
      this.log.info({ event: "scan.queued", orgId: input.orgId, scanId: job.id }, "scan.queued");
    }
    const done = tail
      ? tail.then((): Promise<ScanJob> | ScanJob =>
          this.store.deletion(input.orgId) || (connected && !this.store.isConnected(input.orgId, input.subscriptionId))
            ? this.cancel(input.orgId, job)
            : this.execute(input.orgId, job.id, connected),
        )
      : this.execute(input.orgId, job.id, connected);
    const settled = done.catch(() => undefined);
    this.#queues.set(input.orgId, settled);
    void settled.then(() => {
      if (this.#queues.get(input.orgId) === settled) {
        this.#queues.delete(input.orgId);
      }
    });
    done.catch((error: unknown) => {
      this.log.error(
        { event: "scan.execution_failed", orgId: input.orgId, scanId: job.id, err: error },
        "scan execution failed",
      );
    });
    return { job, started: true, done };
  }

  private cancel(orgId: string, job: ScanJob, patch: Partial<ScanJob> = {}): ScanJob {
    this.log.info({ event: "scan.cancelled", orgId, scanId: job.id }, "scan.cancelled");
    if (!this.store.hasOrg(orgId) || this.store.deletion(orgId) || !this.store.getJob(orgId, job.id)) {
      return { ...job, ...patch, status: "cancelled" };
    }
    return this.store.patchJob(orgId, job.id, { ...patch, status: "cancelled" });
  }

  private scheduleRetry(orgId: string, subscriptionId: string, finishedAt: string): void {
    const { settings, schedule } = this.store.org(orgId);
    if (!settings.scanScheduleEnabled || (schedule.retryCounts[subscriptionId] ?? 0) >= settings.scanRetryLimit) {
      return;
    }
    const candidate = addHours(finishedAt, RETRY_DELAY_HOURS);
    if (!schedule.retryAt || Date.parse(candidate) < Date.parse(schedule.retryAt)) {
      schedule.retryAt = candidate;
    }
    if (!schedule.regularRunAt || Date.parse(schedule.retryAt) < Date.parse(schedule.regularRunAt)) {
      schedule.nextRunAt = schedule.retryAt;
    }
  }

  private recordFailure(
    orgId: string,
    job: ScanJob,
    startedAt: string,
    failure: { error: unknown; errorCode: string; stored: string; covered: string[] },
  ): ScanJob {
    const checks = checksFromFailure(failure.covered, job.subscriptionId, job.cloud ?? DEFAULT_CLOUD);
    const finishedAt = this.clock();
    const errorId = randomUUID();
    const patch: Partial<ScanJob> = {
      status: "failed",
      complete: false,
      coveredScopes: failure.covered,
      finishedAt,
      error: failure.stored,
      errorId,
      durationMs: durationMsFrom(startedAt, finishedAt),
      coverageSummary: coverageSummaryFrom(checks),
      checks,
    };
    const failed = this.store.getJob(orgId, job.id)
      ? this.store.patchJob(orgId, job.id, patch)
      : { ...job, ...patch };
    if (job.actor === "system") {
      this.scheduleRetry(orgId, job.subscriptionId, finishedAt);
    }
    this.log.error(
      {
        event: "scan.failed",
        orgId,
        scanId: job.id,
        durationMs: failed.durationMs,
        checkCount: checks.length,
        coverageSummary: failed.coverageSummary,
        errorCode: failure.errorCode,
        errorId,
        err: failure.error,
      },
      "scan.failed",
    );
    return failed;
  }

  expireStaleScans(orgId: string, now: string): ScanJob[] {
    return this.store
      .org(orgId)
      .scans.filter(
        (job) =>
          job.status === "running" &&
          job.startedAt !== null &&
          Date.parse(now) - Date.parse(job.startedAt) > this.scanTimeoutMs,
      )
      .map((job) => {
        const error = new Error(`scan exceeded ${this.scanTimeoutMs}ms`);
        error.name = "TimeoutError";
        return this.recordFailure(orgId, job, job.startedAt ?? now, {
          error,
          errorCode: "harvest_timeout",
          stored: "harvest_timeout",
          covered: [],
        });
      });
  }

  private async execute(orgId: string, jobId: string, connectedAtStart: boolean): Promise<ScanJob> {
    const current = this.store.getJob(orgId, jobId);
    if (!current) {
      throw new Error(`scan ${jobId} missing`);
    }
    const startedAt = this.clock();
    this.store.patchJob(orgId, jobId, { status: "running", startedAt });
    const { signal, release } = this.store.trackScan(orgId);
    const scanFields = { orgId, scanId: jobId };
    this.log.info({ event: "scan.start", ...scanFields }, "scan.start");
    const cancelled = (): ScanJob => this.cancel(orgId, current, { startedAt });
    const deadline = Date.parse(startedAt) + this.scanTimeoutMs;
    const remainingMs = () => Math.max(0, deadline - Date.parse(this.clock()));
    let harvesting = true;
    try {
      const settings = this.store.view(orgId).settings;
      const result = await abortable(
        signal,
        this.harvester.harvest({
          orgId,
          subscriptionId: current.subscriptionId,
          settings,
        }),
        remainingMs(),
      );
      harvesting = false;
      if (signal.aborted) {
        return cancelled();
      }
      this.store.patchJob(orgId, jobId, { cloud: result.inventory.cloud });
      const checked = runChecks({
        inventory: result.inventory,
        facts: result.facts,
        checkIds: registeredCheckIds(result.inventory.cloud),
        scopes: [current.subscriptionId],
        settings,
      });
      const replaceIds = new Set(registeredCheckIds(result.inventory.cloud));
      const provider = providerFor(result.inventory.cloud);
      const postHarvest = provider.collectHarvests
        ? await provider.collectHarvests({
            orgId,
            subscriptionId: current.subscriptionId,
            signal,
            remainingMs,
            clock: this.clock,
            clients: this.harvestClients,
            store: this.store,
          })
        : NO_POST_HARVEST;
      if (!postHarvest || signal.aborted) {
        return cancelled();
      }
      const live = this.store.getJob(orgId, jobId);
      if (live?.status !== "running") {
        return live ?? cancelled();
      }
      if (connectedAtStart && !this.store.isConnected(orgId, current.subscriptionId)) {
        return cancelled();
      }
      const fresh = this.store.view(orgId);
      this.store.putInventory(
        orgId,
        mergeScanInventory(asMutable<Inventory | undefined>(fresh.inventories[result.inventory.cloud]), result.inventory, current.subscriptionId),
      );
      this.store.putFacts(
        orgId,
        mergeScanFacts(fresh.facts, result.facts, result.inventory, current.subscriptionId),
      );
      const merged = postHarvest.apply({
        findings: mergeScanFindings(fresh.findings, checked.findings, replaceIds, current.subscriptionId),
        coverage: mergeScanCoverage(fresh.coverage, checked.coverage, replaceIds, current.subscriptionId),
      });
      const findings = merged.findings;
      this.store.putFindings(orgId, findings);
      this.store.putCoverage(orgId, merged.coverage);
      const written = this.store.view(orgId);
      const coverage = written.coverage;
      this.store.putIssues(
        orgId,
        applyScanToIssues({
          issues: written.issues,
          findings,
          coverage,
          scanId: jobId,
          observedAt: result.inventory.observedAt,
        }),
      );
      const checks = checksFromCoverage(coverage, current.subscriptionId);
      const finishedAt = this.clock();
      const succeeded = this.store.patchJob(orgId, jobId, {
        status: "succeeded",
        complete: true,
        coveredScopes: result.coveredScopes,
        finishedAt,
        error: null,
        durationMs: durationMsFrom(startedAt, finishedAt),
        coverageSummary: coverageSummaryFrom(checks),
        checks,
      });
      this.log.info(
        {
          event: "scan.finish",
          ...scanFields,
          durationMs: succeeded.durationMs,
          checkCount: checks.length,
          coverageSummary: succeeded.coverageSummary,
        },
        "scan.finish",
      );
      return succeeded;
    } catch (error) {
      if (signal.aborted) {
        return cancelled();
      }
      const errorCode = failureCode(error, harvesting);
      return this.recordFailure(orgId, this.store.getJob(orgId, jobId) ?? current, startedAt, {
        error,
        errorCode,
        stored: error instanceof ProviderNotConfiguredError ? PROVIDER_NOT_CONFIGURED : errorCode,
        covered: error instanceof ScanFailedError ? error.coveredScopes : [],
      });
    } finally {
      release();
    }
  }
}
