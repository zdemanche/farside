import type { OrgParams, RoutePlugin } from "../http/context.js";
import { sessionOf } from "../http/hooks.js";
import { problem, sendClean } from "../http/responses.js";
import { orgParams } from "../http/schemas.js";
import { audit } from "../observability.js";
import { claimView, MemberLimitError } from "../org-claim.js";

/**
 * GET shows whether the caller's org is claimed and the caller's role in it.
 * POST claims an unclaimed org (caller becomes owner) or joins a claimed one (member).
 * Both are open to any verified user of the org (`claim: true` skips the membership gate);
 * the session's org must still match the route's org, so another tenant gets 403.
 */
export const claimRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/claim",
    { schema: { params: orgParams }, config: { claim: true } },
    async (request, reply) => {
      const { orgId } = request.params;
      const actorId = sessionOf(request)?.actorId ?? "unknown";
      return sendClean(reply, 200, claimView(orgId, await ctx.store.orgClaim(orgId), actorId));
    },
  );

  app.post<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/claim",
    { schema: { params: orgParams }, config: { claim: true } },
    async (request, reply) => {
      const { orgId } = request.params;
      const session = sessionOf(request);
      const actorId = session?.actorId ?? "unknown";
      const claimRole = ctx.identity?.config.claimRole;
      const mayOwn = !claimRole || (session?.roles ?? []).includes(claimRole);
      let result;
      try {
        result = await ctx.store.claimOrg(orgId, actorId, { mayOwn });
      } catch (error) {
        if (error instanceof MemberLimitError) {
          return problem(reply, 409, "Member limit reached", { error: "member_limit" });
        }
        throw error;
      }
      if (result.outcome === "refused") {
        audit(request.log, "org.claim", { orgId, actorId, outcome: "refused" });
        return problem(reply, 403, "Claim needs the owner role", { error: "claim_role_required" });
      }
      audit(request.log, "org.claim", { orgId, actorId, outcome: result.outcome, role: result.role });
      return sendClean(reply, result.outcome === "claimed" ? 201 : 200, {
        outcome: result.outcome,
        ...claimView(orgId, result.claim, actorId),
      });
    },
  );
};
