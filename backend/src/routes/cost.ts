import { applyCostCoverage, harvestCost, unconfiguredCostClient } from "../cost.js";
import { guardProviderClient } from "../demo.js";
import { buildHeadline } from "../headline.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import {
  cloudFilter,
  problem,
  cloudOf,
  requireConnected,
  sendClean,
  withProvider,
} from "../http/responses.js";
import { cloudQuery, costHarvestBody, orgParams } from "../http/schemas.js";
import { costWasteView } from "../waste.js";

export const costRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/cost-waste",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const org = ctx.store.snapshot(request.params.orgId);
      return sendClean(
        reply,
        200,
        costWasteView({
          cost: org.cost,
          alerts: org.alerts,
          commitments: org.commitments,
          findings: cloudFilter(org.findings, cloud, (finding) => finding.scope.cloud),
          coverage: cloudFilter(org.coverage, cloud, (entry) => entry.cloud),
        }),
      );
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/headline",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const org = ctx.store.snapshot(request.params.orgId);
      return sendClean(
        reply,
        200,
        buildHeadline({
          cost: org.cost,
          findings: org.findings,
          coverage: org.coverage,
          now: ctx.clock(),
          ...(cloud ? { cloud: cloud } : {}),
        }),
      );
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/cost",
    { schema: { params: orgParams } },
    async (request, reply) => {
      const cost = ctx.store.snapshot(request.params.orgId).cost;
      return cost ? sendClean(reply, 200, cost) : problem(reply, 404, "Not found");
    },
  );

  app.post<{ Params: OrgParams; Body: { subscriptionId: string; agreementType?: string } }>(
    "/v1/orgs/:orgId/cost",
    {
      schema: { params: orgParams, body: costHarvestBody },
      config: {
        rejectSecrets: true,
        invalidTitle: "Invalid cost harvest",
        demo: (store, orgId) => ({
          status: 200,
          body: { harvested: true, cost: store.snapshot(orgId).cost },
        }),
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const connected = requireConnected(
        ctx,
        request,
        reply,
        request.body.subscriptionId,
        "Invalid cost harvest",
      );
      if (!connected) {
        return reply;
      }
      const harvested = await withProvider(reply, () =>
        harvestCost({
          client: guardProviderClient(orgId, ctx.clients.cost ?? unconfiguredCostClient()),
          subscriptionId: connected,
          billingScope: `/subscriptions/${connected}`,
          agreementType: request.body.agreementType || "payg",
          asOf: ctx.clock(),
        }),
      );
      if (!harvested.ok) {
        return reply;
      }
      const costHarvest = harvested.value;
      ctx.store.putCoverage(
        orgId,
        applyCostCoverage(ctx.store.snapshot(orgId).coverage, costHarvest.coverage),
      );
      if (!costHarvest.ok) {
        ctx.store.putCost(orgId, null, connected);
        return sendClean(reply, 200, {
          harvested: false,
          reason: costHarvest.reason,
          closer: costHarvest.coverage[0]?.closer,
        });
      }
      ctx.store.putCost(orgId, costHarvest.snapshot, connected);
      return sendClean(reply, 200, { harvested: true, cost: costHarvest.snapshot });
    },
  );
};
