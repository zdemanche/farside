import type { OrgParams, RoutePlugin } from "../http/context.js";
import { problem, sendClean } from "../http/responses.js";
import { orgParams, settingsBody } from "../http/schemas.js";
import { audit } from "../observability.js";
import { parseSettings } from "../settings.js";

export const settingsRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/settings",
    { schema: { params: orgParams } },
    async (request, reply) => sendClean(reply, 200, ctx.store.snapshot(request.params.orgId).settings),
  );

  app.put<{ Params: OrgParams; Body: { asOf?: string } }>(
    "/v1/orgs/:orgId/settings",
    {
      schema: { params: orgParams, body: settingsBody },
      config: { rejectSecrets: true, invalidTitle: "Invalid settings" },
    },
    async (request, reply) => {
      const parsed = parseSettings(request.body);
      if (!parsed) {
        return problem(reply, 400, "Invalid settings");
      }
      const { orgId } = request.params;
      const saved = ctx.store.putSettings(orgId, { ...parsed, updatedAt: ctx.clock() });
      const schedule = ctx.scheduler.applySettings(orgId, ctx.clientTime(request.body.asOf));
      audit(request.log, "settings.change");
      return sendClean(reply, 200, { ...saved, nextRunAt: schedule.nextRunAt });
    },
  );
};
