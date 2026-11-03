import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Inventory } from "@farside/scan-contracts";
import {
  AZURE_LAUNCH_CHECK_IDS,
  coverageFromHarvest,
  type CoverageEntry,
  type CoverageState,
} from "./coverage.js";
import { applyCoverageResult } from "./coverage.js";
import { factsFromManifest, type ResourceFacts } from "./facts.js";
import { applyOwnerTag, inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { CHECK_REGISTRY, runChecks } from "./checks.js";
import { applyScanToIssues } from "./issues.js";
import type { OrgSettings } from "./settings.js";
import type { MemoryStore } from "./store.js";

export type ScanStatus = "queued" | "running" | "succeeded" | "failed";

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

export class ScanFailedError extends Error {
  constructor(
    message: string,
    readonly coveredScopes: string[],
  ) {
    super(message);
    this.name = "ScanFailedError";
  }
}

export function fixtureHarvester(inventory: Inventory, facts: ResourceFacts[] = []): Harvester {
  return {
    async harvest(input) {
      const coverage = coverageFromHarvest([input.subscriptionId], AZURE_LAUNCH_CHECK_IDS);
      return {
        inventory: applyOwnerTag(inventory, input.settings.ownerTagKey),
        coverage,
        coveredScopes: coverage
          .filter((entry) => entry.state === "assessed")
          .map((entry) => entry.id),
        facts,
      };
    },
  };
}

export function defaultHarvester(): Harvester {
  const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
  ) as GroundTruthManifest;
  return fixtureHarvester(inventoryFromManifest(manifest), factsFromManifest(manifest));
}

export class ScanRunner {
  constructor(
    private readonly store: MemoryStore,
    private readonly harvester: Harvester,
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
      actor: input.actor,
      status: "queued",
      complete: false,
      coveredScopes: [],
      createdAt: "1970-01-01T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      error: null,
      durationMs: null,
      coverageSummary: EMPTY_COVERAGE_SUMMARY,
      checks: [],
    });
    return { job, started: true, done: this.execute(input.orgId, job.id) };
  }

  private async execute(orgId: string, jobId: string): Promise<ScanJob> {
    const current = this.store.getJob(orgId, jobId);
    if (!current) {
      throw new Error(`scan ${jobId} missing`);
    }
    this.store.patchJob(orgId, jobId, {
      status: "running",
      startedAt: "1970-01-01T00:00:00.000Z",
    });
    try {
      const settings = this.store.snapshot(orgId).settings;
      const result = await this.harvester.harvest({
        orgId,
        subscriptionId: current.subscriptionId,
        settings,
      });
      this.store.putInventory(orgId, result.inventory);
      this.store.putFacts(orgId, result.facts);
      let coverage = result.coverage;
      const checked = runChecks({
        inventory: result.inventory,
        facts: result.facts,
        checkIds: Object.keys(CHECK_REGISTRY),
        settings,
      });
      this.store.putFindings(orgId, checked.findings);
      for (const entry of checked.coverage) {
        coverage = applyCoverageResult(coverage, {
          subscriptionOrProject: entry.subscriptionOrProject,
          checkId: entry.checkId,
          state: entry.state,
          ...(entry.causeId ? { causeId: entry.causeId } : {}),
          ...(entry.closer ? { closer: entry.closer } : {}),
        });
      }
      this.store.putCoverage(orgId, coverage);
      this.store.putIssues(
        orgId,
        applyScanToIssues({
          issues: this.store.snapshot(orgId).issues,
          findings: checked.findings,
          coverage,
          scanId: jobId,
          observedAt: result.inventory.observedAt,
        }),
      );
      const checks = checksFromCoverage(coverage, current.subscriptionId);
      const finishedAt = "1970-01-01T00:00:00.001Z";
      return this.store.patchJob(orgId, jobId, {
        status: "succeeded",
        complete: true,
        coveredScopes: result.coveredScopes,
        finishedAt,
        error: null,
        durationMs: durationMsFrom("1970-01-01T00:00:00.000Z", finishedAt),
        coverageSummary: coverageSummaryFrom(checks),
        checks,
      });
    } catch (error) {
      const covered = error instanceof ScanFailedError ? error.coveredScopes : [];
      const checks = checksFromFailure(covered, current.subscriptionId);
      const finishedAt = "1970-01-01T00:00:00.001Z";
      return this.store.patchJob(orgId, jobId, {
        status: "failed",
        complete: false,
        coveredScopes: covered,
        finishedAt,
        error: error instanceof Error ? error.message : "scan failed",
        durationMs: durationMsFrom("1970-01-01T00:00:00.000Z", finishedAt),
        coverageSummary: coverageSummaryFrom(checks),
        checks,
      });
    }
  }
}
