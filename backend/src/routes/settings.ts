import type { OrgParams, RoutePlugin } from "../http/context.js";
import { sendClean } from "../http/responses.js";
import { orgParams, settingsBody } from "../http/schemas.js";
import { audit } from "../observability.js";
import { settingsFromInput, type SettingsInput } from "../settings.js";

export const settingsRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/settings",
    { schema: { params: orgParams } },
    async (request, reply) =>
      sendClean(reply, 200, (await ctx.store.read(request.params.orgId, "settings")).settings),
  );

  app.put<{ Params: OrgParams; Body: SettingsInput & { asOf?: string } }>(
    "/v1/orgs/:orgId/settings",
    {
      schema: { params: orgParams, body: settingsBody },
      config: { rejectSecrets: true, invalidTitle: "Invalid settings" },
    },
    async (request, reply) => {
      const parsed = settingsFromInput(request.body);
      const { orgId } = request.params;
      const saved = await ctx.store.putSettings(orgId, { ...parsed, updatedAt: ctx.clock() });
      const schedule = await ctx.scheduler.applySettings(orgId, ctx.clientTime(request.body.asOf));
      audit(request.log, "settings.change");
      return sendClean(reply, 200, { ...saved, nextRunAt: schedule.nextRunAt });
    },
  );
};
