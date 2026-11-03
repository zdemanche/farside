import { HEALTH_SCORE_FORMULA } from "@farside/scan-contracts";
import { blindSpots, coverageHealth } from "../coverage.js";
import { estateOverview } from "../estate.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { cloudFilter, cloudOf, sendClean } from "../http/responses.js";
import { cloudQuery, orgParams } from "../http/schemas.js";

export const estateRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/blind-spots",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const org = await ctx.store.read(request.params.orgId, "coverage", "findings");
      const coverage = cloudFilter(org.coverage, cloud, (entry) => entry.cloud);
      const findings = cloudFilter(org.findings, cloud, (finding) => finding.scope.cloud);
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
      const cloud = cloudOf(request.query);
      return sendClean(reply, 200, estateOverview(
          await ctx.store.read(request.params.orgId, "inventories", "inventory", "coverage", "findings"),
          cloud,
        ));
    },
  );
};
