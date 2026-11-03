import { demoDescriptor } from "../demo.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { sendClean } from "../http/responses.js";
import { orgParams } from "../http/schemas.js";

export const SERVICE_NAME = "farside";

export const healthRoutes: RoutePlugin = () => async (app) => {
  app.get("/health", async () => ({
    status: "ok" as const,
    service: SERVICE_NAME,
  }));

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId",
    { schema: { params: orgParams } },
    async (request, reply) => sendClean(reply, 200, demoDescriptor(request.params.orgId)),
  );
};
