import type { OrgParams, RoutePlugin } from "../http/context.js";
import { problem, sendClean, sendStored } from "../http/responses.js";
import { connectionBody, connectionParams, orgParams } from "../http/schemas.js";
import { canScan } from "../billing.js";
import { audit } from "../observability.js";
import type { Cloud } from "../cloud.js";
import { DEFAULT_CLOUD } from "../providers/index.js";
import { probeRoles } from "../role-probe.js";

type ConnectionInput = { tenantId: string; subscriptionId: string; cloud?: Cloud; asOf?: string };

export const connectionRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/connections",
    { schema: { params: orgParams } },
    async (request, reply) =>
      sendStored(reply, 200, await ctx.store.read(request.params.orgId, "connections")),
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
      const grantedRoles = await ctx.roleLister.list({
        tenantId,
        subscriptionId,
        cloud: cloud ?? DEFAULT_CLOUD,
      });
      const connection = await ctx.store.putConnection(orgId, {
        tenantId,
        subscriptionId,
        grantedRoles,
        ...(cloud ? { cloud } : {}),
      });
      audit(request.log, "connection.connect");
      await ctx.scheduler.applySettings(orgId, ctx.clientTime(asOf));
      if (!canScan((await ctx.store.read(orgId, "contract")).contract, ctx.clock())) {
        return sendClean(reply, 201, {
          ...connection,
          scan: null,
          scanStarted: false,
          attention: "scans paused",
        });
      }
      const scan = await ctx.runner.start({ orgId, subscriptionId, actor: "user" });
      return sendClean(reply, 201, { ...connection, scan: scan.job, scanStarted: scan.started });
    },
  );

  app.post<{ Params: { orgId: string; connectionId: string } }>(
    "/v1/orgs/:orgId/connections/:connectionId/roles",
    { schema: { params: connectionParams } },
    async (request, reply) => {
      const { orgId, connectionId } = request.params;
      const existing = (await ctx.store.read(orgId, "connections")).connections.find(
        (item) => item.id === connectionId,
      );
      if (!existing) {
        return problem(reply, 404, "Not found");
      }
      const grantedRoles = await ctx.roleLister.list({
        tenantId: existing.tenantId,
        subscriptionId: existing.subscriptionId,
        cloud: existing.cloud,
      });
      const probed = probeRoles(existing.cloud, grantedRoles);
      const patched = await ctx.store.patchConnection(orgId, connectionId, probed);
      audit(request.log, probed.healthy ? "connection.roles" : "connection.revoked");
      return sendClean(reply, 200, patched);
    },
  );

  app.delete<{ Params: { orgId: string; connectionId: string } }>(
    "/v1/orgs/:orgId/connections/:connectionId",
    { schema: { params: connectionParams } },
    async (request, reply) => {
      if (!(await ctx.store.deleteConnection(request.params.orgId, request.params.connectionId))) {
        return problem(reply, 404, "Not found");
      }
      audit(request.log, "connection.disconnect");
      return reply.code(204).send();
    },
  );
};
