import type { Coverage, Finding } from "./types.js";

/**
 * Health score formula (this package is the only implementation; screens must import it).
 *
 * coverage = assessedScopes / totalScopes (0 when there are no scopes).
 * Unassessed scopes contribute nothing to the score: they are omitted from both
 * the numerator and the denominator of the score. Coverage still reports them.
 *
 * If there are no findings, score is null — coverage only.
 * If there are findings but no assessed scopes, score is also null.
 * Otherwise score = 100 * (1 - failingAssessedFindings / assessedScopes), clamped to 0..100.
 */
export const HEALTH_SCORE_FORMULA =
  "coverage = assessed / total scopes; score is null when there are no findings; otherwise score uses only assessed scopes: 100 * (1 - failingAssessed / assessed).";

export type HealthScore = {
  coverage: number;
  assessedScopes: number;
  unassessedScopes: number;
  score: number | null;
};

export function scoreHealth(coverage: Coverage, findings: Finding[]): HealthScore {
  const assessed = coverage.scopes.filter((scope) => scope.assessed);
  const unassessed = coverage.scopes.filter((scope) => !scope.assessed);
  const total = coverage.scopes.length;
  const coverageRatio = total === 0 ? 0 : assessed.length / total;

  if (findings.length === 0 || assessed.length === 0) {
    return {
      coverage: coverageRatio,
      assessedScopes: assessed.length,
      unassessedScopes: unassessed.length,
      score: null,
    };
  }

  const assessedIds = new Set(assessed.map((scope) => scope.id));
  const failingAssessed = findings.filter(
    (finding) => finding.result === "fail" && assessedIds.has(finding.scope.id),
  ).length;
  const raw = 100 * (1 - failingAssessed / assessed.length);
  const score = Math.max(0, Math.min(100, raw));

  return {
    coverage: coverageRatio,
    assessedScopes: assessed.length,
    unassessedScopes: unassessed.length,
    score,
  };
}
