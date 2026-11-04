import { analyzeAlerts, type DailyCost, type SpendAlert } from "../alerts.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { problem, sendClean } from "../http/responses.js";
import { alertsBody, orgParams } from "../http/schemas.js";

type AlertsBody = {
  rows?: DailyCost[];
  recipients?: string[];
  previous?: SpendAlert[];
  asOf?: string;
};

export const alertRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/alerts",
    { schema: { params: orgParams } },
    async (request, reply) => {
      const { alerts } = await ctx.store.read(request.params.orgId, "alerts");
      return alerts ? sendClean(reply, 200, alerts) : problem(reply, 404, "Not found");
    },
  );

  app.post<{ Params: OrgParams; Body: AlertsBody }>(
    "/v1/orgs/:orgId/alerts",
    {
      schema: { params: orgParams, body: alertsBody },
      config: {
        rejectSecrets: true,
        invalidTitle: "Invalid alerts",
        demo: async (store, orgId) => ({ status: 200, body: (await store.read(orgId, "alerts")).alerts }),
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (!body.rows) {
        return problem(reply, 409, "No cost series");
      }
      const asOf =
        ctx.trustClientClock && typeof body.asOf === "string"
          ? body.asOf
          : ctx.clock().slice(0, 10);
      const settings = (await ctx.store.read(request.params.orgId, "settings")).settings;
      const analysis = analyzeAlerts({
        rows: body.rows,
        asOf,
        recipients: body.recipients ?? [...settings.alertRecipients],
        previous: body.previous ?? [],
        mailer: ctx.mailer,
      });
      await ctx.store.putAlerts(request.params.orgId, analysis);
      return sendClean(reply, 200, analysis);
    },
  );
};
