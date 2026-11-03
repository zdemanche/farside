import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cloud, Finding, Inventory } from "@farside/scan-contracts";
import {
  applyBudgetCoverage,
  harvestBudgets,
  mergeBudgetFindings,
  type BudgetClient,
} from "./budgets.js";
import { registeredCheckIds, runChecks } from "./checks.js";
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
import type { OrgSettings } from "./settings.js";
import type { MemoryStore } from "./store.js";

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
  return jobs.map((job) => toScanView(job, job.id === currentId));
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
        !(replaceCheckIds.has(finding.checkId) && finding.scope.subscriptionOrProject === subscriptionId),
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
    (entry) => !(replaceCheckIds.has(entry.checkId) && entry.subscriptionOrProject === subscriptionId),
  );
  return next.reduce((coverage, entry) => applyCoverageResult(coverage, entry), kept);
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
  const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
  ) as GroundTruthManifest;
  return fixtureHarvester(inventoryFromManifest(manifest), factsFromManifest(manifest), clock);
}

export class ScanRunner {
  constructor(
    private readonly store: MemoryStore,
    private readonly harvester: Harvester,
    private readonly harvestClients: ScanHarvestClients = {},
    private readonly clock: Clock = systemClock,
  ) {}

  start(input: { orgId: string; subscriptionId: string; actor: "user" | "system" }): {
    job: ScanJob;
    started: boolean;
    done: Promise<ScanJob>;
  } {
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
    const done = this.execute(input.orgId, job.id);
    done.catch(() => undefined);
    return { job, started: true, done };
  }

  private async execute(orgId: string, jobId: string): Promise<ScanJob> {
    const current = this.store.getJob(orgId, jobId);
    if (!current) {
      throw new Error(`scan ${jobId} missing`);
    }
    const startedAt = this.clock();
    this.store.patchJob(orgId, jobId, { status: "running", startedAt });
    const { signal, release } = this.store.trackScan(orgId);
    const cancelled = (): ScanJob => ({ ...current, status: "cancelled", startedAt });
    try {
      const settings = this.store.snapshot(orgId).settings;
      const result = await this.harvester.harvest({
        orgId,
        subscriptionId: current.subscriptionId,
        settings,
      });
      if (signal.aborted) {
        return cancelled();
      }
      this.store.putInventory(orgId, result.inventory);
      this.store.putFacts(orgId, result.facts);
      this.store.patchJob(orgId, jobId, { cloud: result.inventory.cloud });
      const checked = runChecks({
        inventory: result.inventory,
        facts: result.facts,
        checkIds: registeredCheckIds(result.inventory.cloud),
        settings,
      });
      const replaceIds = new Set(registeredCheckIds(result.inventory.cloud));
      const existing = this.store.snapshot(orgId);
      let findings = mergeScanFindings(
        existing.findings,
        checked.findings,
        replaceIds,
        current.subscriptionId,
      );
      let coverage = mergeScanCoverage(
        existing.coverage,
        checked.coverage,
        replaceIds,
        current.subscriptionId,
      );
      if (result.inventory.cloud === "azure") {
        const harvested = await this.runAzureHarvests(orgId, current.subscriptionId, findings, coverage);
        findings = harvested.findings;
        coverage = harvested.coverage;
        coverage = fillUnrunLaunchCoverage(coverage, current.subscriptionId);
      }
      this.store.putFindings(orgId, findings);
      this.store.putCoverage(orgId, coverage);
      this.store.putIssues(
        orgId,
        applyScanToIssues({
          issues: this.store.snapshot(orgId).issues,
          findings,
          coverage,
          scanId: jobId,
          observedAt: result.inventory.observedAt,
        }),
      );
      const checks = checksFromCoverage(coverage, current.subscriptionId);
      const finishedAt = this.clock();
      return this.store.patchJob(orgId, jobId, {
        status: "succeeded",
        complete: true,
        coveredScopes: result.coveredScopes,
        finishedAt,
        error: null,
        durationMs: durationMsFrom(startedAt, finishedAt),
        coverageSummary: coverageSummaryFrom(checks),
        checks,
      });
    } catch (error) {
      if (signal.aborted) {
        return cancelled();
      }
      const covered = error instanceof ScanFailedError ? error.coveredScopes : [];
      const checks = checksFromFailure(covered, current.subscriptionId);
      const finishedAt = this.clock();
      return this.store.patchJob(orgId, jobId, {
        status: "failed",
        complete: false,
        coveredScopes: covered,
        finishedAt,
        error: error instanceof Error ? error.message : "scan failed",
        durationMs: durationMsFrom(startedAt, finishedAt),
        coverageSummary: coverageSummaryFrom(checks),
        checks,
      });
    } finally {
      release();
    }
  }

  private async runAzureHarvests(
    orgId: string,
    subscriptionId: string,
    findings: Finding[],
    coverage: CoverageEntry[],
  ): Promise<{ findings: Finding[]; coverage: CoverageEntry[] }> {
    const billingScope = `/subscriptions/${subscriptionId}`;
    if (this.harvestClients.costClient) {
      const harvested = await harvestCost({
        client: this.harvestClients.costClient,
        subscriptionId,
        billingScope,
        agreementType: "payg",
      });
      coverage = applyCostCoverage(coverage, harvested.coverage);
      this.store.putCost(orgId, harvested.ok ? harvested.snapshot : null);
    }
    if (this.harvestClients.commitmentClient) {
      const harvested = await harvestCommitments({
        client: this.harvestClients.commitmentClient,
        subscriptionId,
        billingScope,
      });
      coverage = applyCommitmentCoverage(coverage, harvested.coverage);
      if (harvested.ok) {
        this.store.putCommitments(orgId, harvested.snapshot);
        findings = mergeCommitmentFindings(findings, harvested.findings);
      } else {
        this.store.putCommitments(orgId, null);
      }
    }
    if (this.harvestClients.budgetClient) {
      const harvested = await harvestBudgets({
        client: this.harvestClients.budgetClient,
      });
      coverage = applyBudgetCoverage(coverage, harvested.coverage);
      this.store.putBudgets(orgId, harvested.snapshot);
      findings = mergeBudgetFindings(findings, harvested.findings);
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
