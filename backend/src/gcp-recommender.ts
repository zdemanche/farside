import { assertValid, validateFinding, type Finding, type Inventory } from "@farside/scan-contracts";
import { bool, checkDefinition, indexFacts, nonEmptyStr, num, str } from "./checks/define.js";
import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import { projectOf } from "./providers/gcp-scope.js";
import { PointSavingsError, savingsRange } from "./savings.js";

export const GCP_IDLE_RECS = "gcp-waste-idle-vm-and-disk-recommendations";
export const REC_TYPE = "recommender.googleapis.com/Recommendation";

export const RECOMMENDER_SAVINGS_BASIS =
  "Recommender savings range when present; otherwise undetermined, not a point value";

/**
 * #199. Live Recommender gives one projected monthly saving. It is the most the action can save, and it may save
 * nothing if the recommendation is wrong, so the live reader (when switched on) reports 0 up to that figure and
 * marks it with savingsCeiling. Facts without the mark keep RECOMMENDER_SAVINGS_BASIS and the point-value rule.
 */
export const RECOMMENDER_CEILING_BASIS =
  "Up to Recommender's projected monthly saving; Recommender gives one figure, so the lower bound is zero";

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
  /** The range runs from zero up to Recommender's one projected figure (#199). */
  savingsCeiling?: boolean;
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

export function recommenderSavings(
  min: number,
  max: number,
  currency: string,
  basis: string = RECOMMENDER_SAVINGS_BASIS,
) {
  return savingsRange({ min, max, currency, basis });
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
      resourceUri: row.resourceName,
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
      const savings = recommenderSavings(
        row.savingsMin,
        row.savingsMax,
        row.currency ?? "USD",
        row.savingsCeiling ? RECOMMENDER_CEILING_BASIS : RECOMMENDER_SAVINGS_BASIS,
      );
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

function harvestRecommendations(
  inventory: Inventory,
  facts: ResourceFacts[],
): Map<string, GcpRecommendation[]> {
  const rows = indexFacts(facts);
  const byProject = new Map<string, GcpRecommendation[]>();
  for (const resource of inventory.resources) {
    const project = projectOf(resource.resourceUri);
    if (!byProject.has(project)) {
      byProject.set(project, []);
    }
    if (resource.resourceType !== REC_TYPE) {
      continue;
    }
    const fields = rows.get(resource.resourceUri)?.fields;
    const projectId = nonEmptyStr(fields, "projectId") ?? project;
    const list = byProject.get(projectId) ?? [];
    const savingsMin = num(fields, "savingsMin");
    const savingsMax = num(fields, "savingsMax");
    const currency = str(fields, "currency");
    const savingsCeiling = bool(fields, "savingsCeiling") === true;
    list.push({
      recommendationId: nonEmptyStr(fields, "recommendationId") ?? resource.displayName,
      recommenderId: nonEmptyStr(fields, "recommenderId") ?? "",
      resourceName: nonEmptyStr(fields, "resourceName") ?? resource.resourceUri,
      subtype: nonEmptyStr(fields, "subtype") ?? "",
      projectId,
      ...(savingsMin === null ? {} : { savingsMin }),
      ...(savingsMax === null ? {} : { savingsMax }),
      ...(currency ? { currency } : {}),
      ...(savingsCeiling ? { savingsCeiling } : {}),
    });
    byProject.set(projectId, list);
  }
  return byProject;
}

export const checkGcpIdleRecs = checkDefinition({ checkId: GCP_IDLE_RECS, cloud: "gcp" }, (inventory, facts) => {
  const findings: Finding[] = [];
  for (const [projectId, recommendations] of harvestRecommendations(inventory, facts)) {
    findings.push(...checkGcpIdleRecommendations(projectId, { ok: true, recommendations }).findings);
  }
  return findings;
});
