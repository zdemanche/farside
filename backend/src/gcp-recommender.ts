import { assertValid, validateFinding, type Finding } from "@farside/scan-contracts";
import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { PointSavingsError, savingsRange } from "./savings.js";

export const GCP_IDLE_RECS = "gcp-waste-idle-vm-and-disk-recommendations";

export const RECOMMENDER_SAVINGS_BASIS =
  "Recommender savings range when present; otherwise undetermined, not a point value";

export const EMPTY_RECOMMENDER_WORDING =
  "None were returned. Idle status is unknown.";

export const RECOMMENDER_ROLE_CLOSER = "Grant Recommender Viewer and a recommendation list for that project";

export const RECOMMENDER_RANGE_CLOSER = "A recommendation primaryImpact with a min/max cost range";

export type GcpRecommendation = {
  recommendationId: string;
  recommenderId: string;
  resourceName: string;
  subtype: string;
  projectId: string;
  savingsMin?: number;
  savingsMax?: number;
  currency?: string;
};

export type RecommenderHarvest =
  | { ok: true; recommendations: GcpRecommendation[] }
  | { ok: false; missingRole: true };

function acceptFinding(finding: Finding): Finding {
  assertValid(validateFinding(finding));
  return finding;
}

function scope(projectId: string) {
  return {
    id: `${projectId}:${GCP_IDLE_RECS}`,
    cloud: "gcp" as const,
    subscriptionOrProject: projectId,
  };
}

export function recommenderSavings(min: number, max: number, currency: string) {
  return savingsRange({ min, max, currency, basis: RECOMMENDER_SAVINGS_BASIS });
}

export function checkGcpIdleRecommendations(
  projectId: string,
  harvest: RecommenderHarvest,
): { findings: Finding[]; coverage: CoverageEntry[] } {
  if (!harvest.ok) {
    return {
      findings: [
        acceptFinding({
          checkId: GCP_IDLE_RECS,
          result: "undetermined",
          closer: RECOMMENDER_ROLE_CLOSER,
          evidence: {
            fields: {
              recommendationId: null,
              recommenderId: null,
              resourceName: null,
              subtype: null,
              missingRole: "Recommender Viewer",
            },
          },
          scope: scope(projectId),
        }),
      ],
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: projectId,
          checkId: GCP_IDLE_RECS,
          state: "unassessed",
          causeId: "missing_role",
          closer: RECOMMENDER_ROLE_CLOSER,
        }),
      ],
    };
  }

  if (harvest.recommendations.length === 0) {
    return {
      findings: [
        acceptFinding({
          checkId: GCP_IDLE_RECS,
          result: "pass",
          evidence: {
            fields: {
              noneFound: true,
              recommendationCount: 0,
              emptyResult: EMPTY_RECOMMENDER_WORDING,
            },
          },
          scope: scope(projectId),
        }),
      ],
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: projectId,
          checkId: GCP_IDLE_RECS,
          state: "assessed",
        }),
      ],
    };
  }

  const findings = harvest.recommendations.map((row) => {
    const evidence = {
      recommendationId: row.recommendationId,
      recommenderId: row.recommenderId,
      resourceName: row.resourceName,
      subtype: row.subtype,
    };
    if (typeof row.savingsMin !== "number" || typeof row.savingsMax !== "number") {
      return acceptFinding({
        checkId: GCP_IDLE_RECS,
        result: "undetermined",
        closer: RECOMMENDER_RANGE_CLOSER,
        evidence: { fields: { ...evidence, savingsMin: null, savingsMax: null } },
        scope: scope(projectId),
      });
    }
    try {
      const savings = recommenderSavings(row.savingsMin, row.savingsMax, row.currency ?? "USD");
      return acceptFinding({
        checkId: GCP_IDLE_RECS,
        result: "fail",
        evidence: { fields: { ...evidence, savingsBasis: savings.basis } },
        scope: scope(projectId),
        savings: { min: savings.min, max: savings.max, currency: savings.currency },
      });
    } catch (error) {
      if (error instanceof PointSavingsError) {
        return acceptFinding({
          checkId: GCP_IDLE_RECS,
          result: "undetermined",
          closer: RECOMMENDER_RANGE_CLOSER,
          evidence: { fields: { ...evidence, savingsMin: row.savingsMin, savingsMax: row.savingsMax } },
          scope: scope(projectId),
        });
      }
      throw error;
    }
  });

  return {
    findings,
    coverage: [
      recordCoverageScope({
        subscriptionOrProject: projectId,
        checkId: GCP_IDLE_RECS,
        state: "assessed",
      }),
    ],
  };
}
