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
      const alerts = ctx.store.snapshot(request.params.orgId).alerts;
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
        demo: (store, orgId) => ({ status: 200, body: store.snapshot(orgId).alerts }),
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
      const analysis = analyzeAlerts({
        rows: body.rows,
        asOf,
        recipients: body.recipients ?? [],
        previous: body.previous ?? [],
      });
      ctx.store.putAlerts(request.params.orgId, analysis);
      return sendClean(reply, 200, analysis);
    },
  );
};
