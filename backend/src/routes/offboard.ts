import { deletionView } from "../offboard.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { problem, sendClean } from "../http/responses.js";
import { offboardBody, orgParams } from "../http/schemas.js";
import { audit } from "../observability.js";
import { sessionFromHeaders } from "../session.js";

type OffboardBody = { confirm?: boolean; exportOffered?: boolean; now?: string };

export const offboardRoutes: RoutePlugin = (ctx) => async (app) => {
  app.post<{ Params: OrgParams; Body: OffboardBody }>(
    "/v1/orgs/:orgId/offboard",
    {
      schema: { params: orgParams, body: offboardBody },
      config: { allowDeleted: true, invalidTitle: "Invalid offboard request" },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const existing = await ctx.store.deletion(orgId);
      if (existing) {
        return sendClean(reply, 200, deletionView(existing));
      }
      const body = request.body;
      if (body.confirm !== true || body.exportOffered !== true) {
        return problem(reply, 400, "Offboard not confirmed", {
          errors: [{ path: "body", message: "confirm and exportOffered must be true" }],
        });
      }
      const actorId = sessionFromHeaders(request)?.actorId ?? "unknown";
      const record = await ctx.store.offboard(orgId, ctx.clientTime(body.now), "customer", actorId);
      audit(request.log, "org.offboard", { trigger: record.trigger });
      return sendClean(reply, 200, deletionView(record));
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/deletion",
    { schema: { params: orgParams }, config: { allowDeleted: true } },
    async (request, reply) => {
      const record = await ctx.store.deletion(request.params.orgId);
      return record
        ? sendClean(reply, 200, deletionView(record))
        : problem(reply, 404, "Not found");
    },
  );
};
