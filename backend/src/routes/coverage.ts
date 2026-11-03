import { HEALTH_SCORE_FORMULA } from "@farside/scan-contracts";
import type { CoverageCauseId } from "../causes.js";
import {
  applyCoverageResult,
  coverageHealth,
  recordCoverageScope,
  toContractCoverage,
  type CoverageState,
} from "../coverage.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { cloudFilter, readCloud, sendClean } from "../http/responses.js";
import { cloudQuery, coverageBody, orgParams } from "../http/schemas.js";

type CoverageBody = {
  subscriptionOrProject: string;
  checkId: string;
  state: CoverageState;
  causeId?: CoverageCauseId;
  closer?: string;
};

export const coverageRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/coverage",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = readCloud(request.query, reply);
      if (!cloud.ok) {
        return reply;
      }
      const org = ctx.store.snapshot(request.params.orgId);
      const coverage = cloudFilter(org.coverage, cloud.cloud, (entry) => entry.cloud);
      const findings = cloudFilter(org.findings, cloud.cloud, (finding) => finding.scope.cloud);
      return sendClean(reply, 200, {
        coverage: toContractCoverage(coverage),
        entries: coverage,
        health: coverageHealth(coverage, findings),
        formula: HEALTH_SCORE_FORMULA,
      });
    },
  );

  app.put<{ Params: OrgParams; Body: CoverageBody }>(
    "/v1/orgs/:orgId/coverage",
    {
      schema: { params: orgParams, body: coverageBody },
      config: { rejectSecrets: true, invalidTitle: "Invalid coverage" },
    },
    async (request, reply) => {
      const { checkId, subscriptionOrProject, state, causeId, closer } = request.body;
      const result: CoverageBody = {
        subscriptionOrProject,
        checkId,
        state,
        ...(causeId === undefined ? {} : { causeId }),
        ...(closer === undefined ? {} : { closer }),
      };
      const next = applyCoverageResult(ctx.store.snapshot(request.params.orgId).coverage, result);
      ctx.store.putCoverage(request.params.orgId, next);
      return sendClean(reply, 200, recordCoverageScope(result));
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/findings",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = readCloud(request.query, reply);
      if (!cloud.ok) {
        return reply;
      }
      const findings = cloudFilter(
        ctx.store.snapshot(request.params.orgId).findings,
        cloud.cloud,
        (finding) => finding.scope.cloud,
      );
      return sendClean(reply, 200, { findings });
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/issues",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = readCloud(request.query, reply);
      if (!cloud.ok) {
        return reply;
      }
      const issues = cloudFilter(
        ctx.store.snapshot(request.params.orgId).issues,
        cloud.cloud,
        (issue) => issue.cloud,
      );
      return sendClean(reply, 200, { issues });
    },
  );
};
