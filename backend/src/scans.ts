import { randomUUID } from "node:crypto";
import type { Cloud, Finding, Inventory } from "@farside/scan-contracts";
import {
  applyBudgetCoverage,
  harvestBudgets,
  mergeBudgetFindings,
  type BudgetClient,
} from "./budgets.js";
import { registeredCheckIds, runChecks, scopeKey } from "./checks.js";
import {
  applyCommitmentCoverage,
  harvestCommitments,
  mergeCommitmentFindings,
  type CommitmentClient,
} from "./commitments.js";
import { applyCostCoverage, harvestCost, type CostQueryClient } from "./cost.js";
import { systemClock, type Clock } from "./clock.js";
import {
  AZURE_LAUNCH_CHECK_IDS,
  applyCoverageResult,
  coverageFromHarvest,
  recordCoverageScope,
  type CoverageEntry,
  type CoverageState,
} from "./coverage.js";
import { factsFromManifest, type ResourceFacts } from "./facts.js";
import { applyOwnerTag, inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { applyScanToIssues } from "./issues.js";
import { PROVIDER_NOT_CONFIGURED, ProviderNotConfiguredError, rejectUnconfigured } from "./providers.js";
import type { OrgSettings } from "./settings.js";
import { silentLog, type LogSink } from "./observability.js";
import { addHours, DEFAULT_SCAN_TIMEOUT_MS, RETRY_DELAY_HOURS } from "./scheduler.js";
import type { MemoryStore } from "./store.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };

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

export type ScanView = ScanJob & { current: boolean };

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
  coverage: CoverageEntry[],
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
): ScanCheckOutcome[] {
  const covered = new Set(coveredScopes);
  return AZURE_LAUNCH_CHECK_IDS.map((checkId) => {
    if (covered.has(`${subscriptionId}:${checkId}`)) {
      return { checkId, state: "assessed" as const };
    }
    return { checkId, state: "unassessed" as const, reason: FAILED_BEFORE_CHECK };
  });
}

export function toScanView(job: ScanJob, current: boolean): ScanView {
  return {
    ...job,
    durationMs: durationMsFrom(job.startedAt, job.finishedAt),
    current: current && job.status === "succeeded" && job.complete,
  };
}

export function toScanViews(jobs: readonly ScanJob[]): ScanView[] {
  let currentId: string | undefined;
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    if (job && job.status === "succeeded" && job.complete) {
      currentId = job.id;
      break;
    }
  }
  return jobs.filter((job) => job.status !== "cancelled").map((job) => toScanView(job, job.id === currentId));
}

export type HarvestResult = {
  inventory: Inventory;
  coverage: CoverageEntry[];
  coveredScopes: string[];
  facts: ResourceFacts[];
};

export type Harvester = {
  harvest: (input: {
    orgId: string;
    subscriptionId: string;
    settings: OrgSettings;
  }) => Promise<HarvestResult>;
};

export type ScanHarvestClients = {
  costClient?: CostQueryClient;
  commitmentClient?: CommitmentClient;
  budgetClient?: BudgetClient;
};

export function mergeScanFindings(
  existing: Finding[],
  next: Finding[],
  replaceCheckIds: ReadonlySet<string>,
  subscriptionId: string,
): Finding[] {
  return [
    ...existing.filter(
      (finding) =>
        !(
          replaceCheckIds.has(finding.checkId) &&
          finding.scope.subscriptionOrProject.toLowerCase() === subscriptionId.toLowerCase()
        ),
    ),
    ...next,
  ];
}

export function mergeScanCoverage(
  existing: CoverageEntry[],
  next: CoverageEntry[],
  replaceCheckIds: ReadonlySet<string>,
  subscriptionId: string,
): CoverageEntry[] {
  const kept = existing.filter(
    (entry) =>
      !(
        replaceCheckIds.has(entry.checkId) &&
        entry.subscriptionOrProject.toLowerCase() === subscriptionId.toLowerCase()
      ),
  );
  return next.reduce((coverage, entry) => applyCoverageResult(coverage, entry), kept);
}

function failureCode(error: unknown, harvesting: boolean): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "harvest_timeout";
  }
  return error instanceof ScanFailedError || harvesting ? "harvest_failed" : "scan_failed";
}

function scannedScopes(inventory: Inventory, subscriptionId: string): Set<string> {
  return new Set(
    [subscriptionId, ...inventory.resources.map((resource) => scopeKey(resource.resourceUri, inventory.cloud))]
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
  const incomingHasEmptyKey = next.resources.some((resource) => scopeKey(resource.resourceUri, next.cloud) === "");
  return {
    ...next,
    resources: [
      ...existing.resources.filter(
        (resource) =>
          !replacedByScan(scopes, scopeKey(resource.resourceUri, existing.cloud), incomingHasEmptyKey),
      ),
      ...next.resources,
    ],
  };
}

export function mergeScanFacts(
  existing: ResourceFacts[],
  next: ResourceFacts[],
  inventory: Inventory,
  subscriptionId: string,
): ResourceFacts[] {
  const scopes = scannedScopes(inventory, subscriptionId);
  const incomingHasEmptyKey = next.some((row) => scopeKey(row.resourceUri, inventory.cloud) === "");
  return [
    ...existing.filter(
      (row) => !replacedByScan(scopes, scopeKey(row.resourceUri, inventory.cloud), incomingHasEmptyKey),
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

export function fixtureHarvester(
  inventory: Inventory,
  facts: ResourceFacts[] = [],
  clock?: Clock,
): Harvester {
  return {
    async harvest(input) {
      const coverage = coverageFromHarvest([input.subscriptionId], AZURE_LAUNCH_CHECK_IDS);
      return {
        inventory: applyOwnerTag(
          clock ? { ...inventory, observedAt: clock() } : inventory,
          input.settings.ownerTagKey,
        ),
        coverage,
        coveredScopes: coverage
          .filter((entry) => entry.state === "assessed")
          .map((entry) => entry.id),
        facts,
      };
    },
  };
}

export function defaultHarvester(clock?: Clock): Harvester {
  const manifest = docAzureGroundTruth as GroundTruthManifest;
  return fixtureHarvester(inventoryFromManifest(manifest), factsFromManifest(manifest), clock);
}

export function unconfiguredHarvester(): Harvester {
  return {
    async harvest() {
      rejectUnconfigured();
    },
  };
}

const MAX_TIMER_MS = 2 ** 31 - 1;

function abortable<T>(signal: AbortSignal, work: Promise<T>, timeoutMs: number): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("scan aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => settle(() => reject(new Error("scan aborted")));
    const timer = setTimeout(() => {
      const error = new Error(`harvest exceeded ${timeoutMs}ms`);
      error.name = "TimeoutError";
      settle(() => reject(error));
    }, Math.min(timeoutMs, MAX_TIMER_MS));
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

type AzureHarvests = {
  cost?: Awaited<ReturnType<typeof harvestCost>>;
  commitments?: Awaited<ReturnType<typeof harvestCommitments>>;
  budgets?: Awaited<ReturnType<typeof harvestBudgets>>;
};

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
    const existing = this.store.runningScan(input.orgId, input.subscriptionId, this.scanTimeoutMs);
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
    if (!this.store.hasOrg(orgId) || this.store.deletion(orgId)) {
      return { ...job, ...patch, status: "cancelled" };
    }
    return this.store.patchJob(orgId, job.id, { ...patch, status: "cancelled" });
  }

  private scheduleRetry(orgId: string, subscriptionId: string, finishedAt: string): void {
    const { settings, schedule } = this.store.org(orgId);
    if (!settings.scanScheduleEnabled || (schedule.retryCounts[subscriptionId] ?? 0) >= settings.scanRetryLimit) {
      return;
    }
    const retryAt = addHours(finishedAt, RETRY_DELAY_HOURS);
    if (!schedule.nextRunAt || Date.parse(retryAt) < Date.parse(schedule.nextRunAt)) {
      schedule.nextRunAt = retryAt;
    }
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
    let harvesting = true;
    try {
      const settings = this.store.snapshot(orgId).settings;
      const result = await abortable(
        signal,
        this.harvester.harvest({
          orgId,
          subscriptionId: current.subscriptionId,
          settings,
        }),
        this.scanTimeoutMs,
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
      const collected =
        result.inventory.cloud === "azure"
          ? await this.collectAzureHarvests(current.subscriptionId, signal)
          : {};
      if (!collected || signal.aborted) {
        return cancelled();
      }
      const live = this.store.getJob(orgId, jobId);
      if (live?.status !== "running") {
        return live ?? cancelled();
      }
      if (connectedAtStart && !this.store.isConnected(orgId, current.subscriptionId)) {
        return cancelled();
      }
      const fresh = this.store.snapshot(orgId);
      this.store.putInventory(
        orgId,
        mergeScanInventory(fresh.inventories[result.inventory.cloud], result.inventory, current.subscriptionId),
      );
      this.store.putFacts(
        orgId,
        mergeScanFacts(fresh.facts, result.facts, result.inventory, current.subscriptionId),
      );
      let findings = mergeScanFindings(fresh.findings, checked.findings, replaceIds, current.subscriptionId);
      let coverage = mergeScanCoverage(fresh.coverage, checked.coverage, replaceIds, current.subscriptionId);
      if (result.inventory.cloud === "azure") {
        const applied = this.applyAzureHarvests(orgId, current.subscriptionId, collected, findings, coverage);
        findings = applied.findings;
        coverage = fillUnrunLaunchCoverage(applied.coverage, current.subscriptionId);
      }
      this.store.putFindings(orgId, findings);
      this.store.putCoverage(orgId, coverage);
      const written = this.store.snapshot(orgId);
      coverage = written.coverage;
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
      const covered = error instanceof ScanFailedError ? error.coveredScopes : [];
      const checks = checksFromFailure(covered, current.subscriptionId);
      const finishedAt = this.clock();
      const errorCode = failureCode(error, harvesting);
      const errorId = randomUUID();
      const failed = this.store.patchJob(orgId, jobId, {
        status: "failed",
        complete: false,
        coveredScopes: covered,
        finishedAt,
        error: error instanceof ProviderNotConfiguredError ? PROVIDER_NOT_CONFIGURED : errorCode,
        errorId,
        durationMs: durationMsFrom(startedAt, finishedAt),
        coverageSummary: coverageSummaryFrom(checks),
        checks,
      });
      if (current.actor === "system") {
        this.scheduleRetry(orgId, current.subscriptionId, finishedAt);
      }
      this.log.error(
        {
          event: "scan.failed",
          ...scanFields,
          durationMs: failed.durationMs,
          checkCount: checks.length,
          coverageSummary: failed.coverageSummary,
          errorCode,
          errorId,
          err: error,
        },
        "scan.failed",
      );
      return failed;
    } finally {
      release();
    }
  }

  private async collectAzureHarvests(subscriptionId: string, signal: AbortSignal): Promise<AzureHarvests | null> {
    const billingScope = `/subscriptions/${subscriptionId}`;
    const collected: AzureHarvests = {};
    if (this.harvestClients.costClient) {
      collected.cost = await abortable(
        signal,
        harvestCost({
        client: this.harvestClients.costClient,
        subscriptionId,
        billingScope,
        agreementType: "payg",
        asOf: this.clock(),
        }),
        this.scanTimeoutMs,
      );
      if (signal.aborted) {
        return null;
      }
    }
    if (this.harvestClients.commitmentClient) {
      collected.commitments = await abortable(
        signal,
        harvestCommitments({
        client: this.harvestClients.commitmentClient,
        subscriptionId,
        billingScope,
        }),
        this.scanTimeoutMs,
      );
      if (signal.aborted) {
        return null;
      }
    }
    if (this.harvestClients.budgetClient) {
      collected.budgets = await abortable(
        signal,
        harvestBudgets({
        client: this.harvestClients.budgetClient,
        lastConfirmed: this.clock(),
        }),
        this.scanTimeoutMs,
      );
      if (signal.aborted) {
        return null;
      }
    }
    return collected;
  }

  private applyAzureHarvests(
    orgId: string,
    subscriptionId: string,
    collected: AzureHarvests,
    findings: Finding[],
    coverage: CoverageEntry[],
  ): { findings: Finding[]; coverage: CoverageEntry[] } {
    if (collected.cost) {
      coverage = applyCostCoverage(coverage, collected.cost.coverage);
      this.store.putCost(orgId, collected.cost.ok ? collected.cost.snapshot : null, subscriptionId);
    }
    if (collected.commitments) {
      coverage = applyCommitmentCoverage(coverage, collected.commitments.coverage);
      if (collected.commitments.ok) {
        this.store.putCommitments(orgId, collected.commitments.snapshot, subscriptionId);
        findings = mergeCommitmentFindings(findings, collected.commitments.findings, subscriptionId);
      } else {
        this.store.putCommitments(orgId, null, subscriptionId);
      }
    }
    if (collected.budgets) {
      coverage = applyBudgetCoverage(coverage, collected.budgets.coverage);
      this.store.putBudgets(orgId, collected.budgets.snapshot);
      findings = mergeBudgetFindings(findings, collected.budgets.findings);
    }
    return { findings, coverage };
  }
}

function fillUnrunLaunchCoverage(coverage: CoverageEntry[], subscriptionId: string): CoverageEntry[] {
  let next = coverage;
  for (const checkId of AZURE_LAUNCH_CHECK_IDS) {
    if (next.some((entry) => entry.checkId === checkId && entry.subscriptionOrProject === subscriptionId)) {
      continue;
    }
    next = applyCoverageResult(
      next,
      recordCoverageScope({
        subscriptionOrProject: subscriptionId,
        checkId,
        state: "unassessed",
        causeId: "not_run",
      }),
    );
  }
  return next;
}
