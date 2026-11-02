import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Inventory } from "@farside/scan-contracts";
import { AZURE_LAUNCH_CHECK_IDS, coverageFromHarvest, type CoverageEntry } from "./coverage.js";
import { applyCoverageResult } from "./coverage.js";
import { factsFromManifest, type ResourceFacts } from "./facts.js";
import { applyOwnerTag, inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { CHECK_REGISTRY, runChecks } from "./checks.js";
import type { OrgSettings } from "./settings.js";
import type { MemoryStore } from "./store.js";

export type ScanStatus = "queued" | "running" | "succeeded" | "failed";

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
};

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
      return this.store.patchJob(orgId, jobId, {
        status: "succeeded",
        complete: true,
        coveredScopes: result.coveredScopes,
        finishedAt: "1970-01-01T00:00:00.001Z",
        error: null,
      });
    } catch (error) {
      const covered = error instanceof ScanFailedError ? error.coveredScopes : [];
      return this.store.patchJob(orgId, jobId, {
        status: "failed",
        complete: false,
        coveredScopes: covered,
        finishedAt: "1970-01-01T00:00:00.001Z",
        error: error instanceof Error ? error.message : "scan failed",
      });
    }
  }
}
