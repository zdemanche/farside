import { CardDataError, advanceContract, billingView, parseContract } from "../billing.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { operatorGuard } from "../http/hooks.js";
import { problem, sendClean } from "../http/responses.js";
import { advanceBody, contractBody, orgParams } from "../http/schemas.js";
import { audit } from "../observability.js";

type ContractEvent = "failed_payment" | "paid" | "ended";

export const contractRoutes: RoutePlugin = (ctx) => async (app) => {
  const operatorOnly = { operator: true };
  const preValidation = operatorGuard(ctx);

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/contract",
    { schema: { params: orgParams } },
    async (request, reply) => {
      const contract = ctx.store.snapshot(request.params.orgId).contract;
      return contract
        ? sendClean(reply, 200, billingView(contract, ctx.clock()))
        : problem(reply, 404, "Not found");
    },
  );

  app.put<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/contract",
    {
      schema: { params: orgParams, body: contractBody },
      config: { ...operatorOnly, rejectSecrets: true, invalidTitle: "Invalid contract" },
      preValidation,
    },
    async (request, reply) => {
      const now = ctx.clock();
      try {
        const parsed = parseContract(request.body, now);
        if (!parsed) {
          return problem(reply, 400, "Invalid contract", {
            errors: [{ path: "body", message: "plan and an ISO startDate are required" }],
          });
        }
        ctx.store.putContract(request.params.orgId, parsed);
        audit(request.log, "contract.change");
        return sendClean(reply, 200, billingView(parsed, now));
      } catch (error) {
        if (error instanceof CardDataError) {
          return problem(reply, 400, "Card data rejected");
        }
        throw error;
      }
    },
  );

  app.post<{ Params: OrgParams; Body: { event?: ContractEvent } }>(
    "/v1/orgs/:orgId/contract/advance",
    {
      schema: { params: orgParams, body: advanceBody },
      config: { ...operatorOnly, invalidTitle: "Invalid contract event" },
      preValidation,
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const current = ctx.store.snapshot(orgId).contract;
      if (!current) {
        return problem(reply, 404, "Not found");
      }
      const now = ctx.clock();
      const event = request.body.event;
      const next = advanceContract(current, event ? { now, event } : { now });
      ctx.store.putContract(orgId, next);
      audit(request.log, "contract.change", { via: "advance" });
      return sendClean(reply, 200, billingView(next, now));
    },
  );
};
