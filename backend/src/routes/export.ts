import type { FastifyReply } from "fastify";
import type { CostSnapshot } from "../cost.js";
import { asMutable } from "../readonly.js";
import { inventoriesFor } from "../estate.js";
import {
  exportCost,
  exportFilename,
  exportInventory,
  exportIssues,
  type ExportKind,
} from "../export.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { cloudFilter, cloudOf, sendClean } from "../http/responses.js";
import { exportQuery, orgParams } from "../http/schemas.js";

type ExportRequestQuery = { asOf?: string };

function attachment(reply: FastifyReply, kind: ExportKind): void {
  void reply.header("content-disposition", `attachment; filename="${exportFilename(kind)}"`);
}

export const exportRoutes: RoutePlugin = (ctx) => async (app) => {
  const schema = { params: orgParams, querystring: exportQuery };

  app.get<{ Params: OrgParams; Querystring: ExportRequestQuery }>(
    "/v1/orgs/:orgId/export/issues",
    { schema },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const issues = cloudFilter(
        (await ctx.store.read(request.params.orgId, "issues")).issues,
        cloud,
        (issue) => issue.cloud,
      );
      attachment(reply, "issues");
      return sendClean(
        reply,
        200,
        exportIssues(request.params.orgId, issues, ctx.clientTime(request.query.asOf)),
      );
    },
  );

  app.get<{ Params: OrgParams; Querystring: ExportRequestQuery }>(
    "/v1/orgs/:orgId/export/inventory",
    { schema },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const org = await ctx.store.read(request.params.orgId, "inventories", "inventory");
      const inventory = cloud ? (inventoriesFor(org, cloud)[0] ?? null) : org.inventory;
      attachment(reply, "inventory");
      return sendClean(
        reply,
        200,
        exportInventory(
          request.params.orgId,
          inventory ?? null,
          ctx.clientTime(request.query.asOf),
        ),
      );
    },
  );

  app.get<{ Params: OrgParams; Querystring: ExportRequestQuery }>(
    "/v1/orgs/:orgId/export/cost",
    { schema },
    async (request, reply) => {
      attachment(reply, "cost");
      return sendClean(
        reply,
        200,
        exportCost(
          request.params.orgId,
          asMutable<CostSnapshot | null>((await ctx.store.read(request.params.orgId, "cost")).cost),
          ctx.clientTime(request.query.asOf),
        ),
      );
    },
  );
};
