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
import { cloudFilter, cloudOf, sendClean, sendStored } from "../http/responses.js";
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
      const cloud = cloudOf(request.query);
      const org = await ctx.store.read(request.params.orgId, "coverage", "findings");
      const coverage = cloudFilter(org.coverage, cloud, (entry) => entry.cloud);
      const findings = cloudFilter(org.findings, cloud, (finding) => finding.scope.cloud);
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
      const { coverage } = await ctx.store.read(request.params.orgId, "coverage");
      await ctx.store.putCoverage(request.params.orgId, applyCoverageResult(coverage, result));
      return sendClean(reply, 200, recordCoverageScope(result));
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/findings",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const findings = cloudFilter(
        (await ctx.store.read(request.params.orgId, "findings")).findings,
        cloud,
        (finding) => finding.scope.cloud,
      );
      return sendStored(reply, 200, { findings });
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/issues",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const issues = cloudFilter(
        (await ctx.store.read(request.params.orgId, "issues")).issues,
        cloud,
        (issue) => issue.cloud,
      );
      return sendStored(reply, 200, { issues });
    },
  );
};
