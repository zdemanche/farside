import { HEALTH_SCORE_FORMULA } from "@farside/scan-contracts";
import { blindSpots, coverageHealth } from "../coverage.js";
import { estateOverview } from "../estate.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { cloudFilter, readCloud, sendClean } from "../http/responses.js";
import { cloudQuery, orgParams } from "../http/schemas.js";

export const estateRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/blind-spots",
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
        spots: blindSpots(coverage),
        health: coverageHealth(coverage, findings),
        formula: HEALTH_SCORE_FORMULA,
      });
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/estate",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = readCloud(request.query, reply);
      if (!cloud.ok) {
        return reply;
      }
      return sendClean(reply, 200, estateOverview(ctx.store.snapshot(request.params.orgId), cloud.cloud));
    },
  );
};
