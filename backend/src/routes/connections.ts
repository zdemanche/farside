import type { OrgParams, RoutePlugin } from "../http/context.js";
import { problem, sendClean, sendStored } from "../http/responses.js";
import { connectionBody, connectionParams, orgParams } from "../http/schemas.js";
import { canScan } from "../billing.js";
import { audit } from "../observability.js";
import type { Cloud } from "../cloud.js";

type ConnectionInput = { tenantId: string; subscriptionId: string; cloud?: Cloud; asOf?: string };

export const connectionRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/connections",
    { schema: { params: orgParams } },
    async (request, reply) =>
      sendStored(reply, 200, { connections: ctx.store.view(request.params.orgId).connections }),
  );

  app.put<{ Params: OrgParams; Body: ConnectionInput }>(
    "/v1/orgs/:orgId/connections",
    {
      schema: { params: orgParams, body: connectionBody() },
      config: { rejectSecrets: true, invalidTitle: "Invalid connection" },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const { tenantId, subscriptionId, cloud, asOf } = request.body;
      const connection = ctx.store.putConnection(orgId, {
        tenantId,
        subscriptionId,
        ...(cloud ? { cloud } : {}),
      });
      audit(request.log, "connection.connect");
      ctx.scheduler.applySettings(orgId, ctx.clientTime(asOf));
      if (!canScan(ctx.store.view(orgId).contract, ctx.clock())) {
        return sendClean(reply, 201, {
          ...connection,
          scan: null,
          scanStarted: false,
          attention: "scans paused",
        });
      }
      const scan = ctx.runner.start({ orgId, subscriptionId, actor: "user" });
      return sendClean(reply, 201, { ...connection, scan: scan.job, scanStarted: scan.started });
    },
  );

  app.delete<{ Params: { orgId: string; connectionId: string } }>(
    "/v1/orgs/:orgId/connections/:connectionId",
    { schema: { params: connectionParams } },
    async (request, reply) => {
      if (!ctx.store.deleteConnection(request.params.orgId, request.params.connectionId)) {
        return problem(reply, 404, "Not found");
      }
      audit(request.log, "connection.disconnect");
      return reply.code(204).send();
    },
  );
};
