import {
  assertValid,
  scoreHealth,
  validateCoverage,
  type Cloud,
  type Coverage,
  type Finding,
  type HealthScore,
} from "@farside/scan-contracts";
import { COVERAGE_CAUSES, type CoverageCauseId } from "./causes.js";
import { cloudFromCheckId } from "./cloud.js";

export type CoverageState = "assessed" | "unassessed" | "undetermined";

export type CoverageEntry = {
  id: string;
  checkId: string;
  cloud: Cloud;
  subscriptionOrProject: string;
  state: CoverageState;
  causeId?: CoverageCauseId;
  reason?: string;
  closer?: string;
};

export type BlindSpot = {
  id: string;
  checkId: string;
  state: "unassessed" | "undetermined";
  reason: string;
  closer: string;
};

export function scopeId(subscriptionOrProject: string, checkId: string): string {
  return `${subscriptionOrProject}:${checkId}`;
}

export function recordCoverageScope(input: {
  subscriptionOrProject: string;
  checkId: string;
  state: CoverageState;
  causeId?: CoverageCauseId;
  closer?: string;
}): CoverageEntry {
  const cause = input.causeId ? COVERAGE_CAUSES[input.causeId] : undefined;
  const entry: CoverageEntry = {
    id: scopeId(input.subscriptionOrProject, input.checkId),
    checkId: input.checkId,
    cloud: cloudFromCheckId(input.checkId),
    subscriptionOrProject: input.subscriptionOrProject,
    state: input.state,
  };
  if (input.causeId) {
    entry.causeId = input.causeId;
  }
  if (cause?.reason) {
    entry.reason = cause.reason;
  }
  const closer = input.closer ?? cause?.closer;
  if (closer) {
    entry.closer = closer;
  }
  return entry;
}

export function toContractCoverage(entries: readonly CoverageEntry[]): Coverage {
  return {
    scopes: entries.map((entry) => ({
      id: entry.id,
      checkId: entry.checkId,
      assessed: entry.state === "assessed",
    })),
  };
}

export function coverageFromHarvest(
  subscriptions: string[],
  checkIds: readonly string[],
  assessedCheckIds: ReadonlySet<string>,
): CoverageEntry[] {
  const entries: CoverageEntry[] = [];
  for (const subscriptionOrProject of subscriptions) {
    for (const checkId of checkIds) {
      if (assessedCheckIds.has(checkId)) {
        entries.push(
          recordCoverageScope({
            subscriptionOrProject,
            checkId,
            state: "assessed",
          }),
        );
      } else {
        entries.push(
          recordCoverageScope({
            subscriptionOrProject,
            checkId,
            state: "unassessed",
            causeId: "not_run",
          }),
        );
      }
    }
  }
  return entries;
}

export type CoverageResult = {
  subscriptionOrProject: string;
  checkId: string;
  state: CoverageState;
  causeId?: CoverageCauseId;
  closer?: string;
};

export function applyCoverageResults(
  entries: readonly CoverageEntry[],
  results: readonly CoverageResult[],
): CoverageEntry[] {
  const incoming = new Map<string, CoverageEntry>();
  for (const result of results) {
    const next = recordCoverageScope(result);
    incoming.delete(next.id);
    incoming.set(next.id, next);
  }
  return [...entries.filter((entry) => !incoming.has(entry.id)), ...incoming.values()];
}

export function applyCoverageResult(
  entries: readonly CoverageEntry[],
  result: CoverageResult,
): CoverageEntry[] {
  return applyCoverageResults(entries, [result]);
}

export function blindSpots(entries: readonly CoverageEntry[]): BlindSpot[] {
  return entries.flatMap((entry) => {
    if (entry.state === "assessed") {
      return [];
    }
    return [
      {
        id: entry.id,
        checkId: entry.checkId,
        state: entry.state,
        reason: entry.reason ?? "Farside could not check this scope.",
        closer: entry.closer ?? "A successful scan of this check on the subscription.",
      },
    ];
  });
}

export function coverageHealth(
  entries: readonly CoverageEntry[],
  findings: Finding[],
): HealthScore {
  const coverage = toContractCoverage(entries);
  assertValid(validateCoverage(coverage));
  return scoreHealth(coverage, findings);
}
