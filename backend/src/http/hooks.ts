import { randomUUID } from "node:crypto";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
  preValidationAsyncHookHandler,
} from "fastify";
import { isReadOnly, retentionElapsed, type Contract } from "../billing.js";
import type { DeletionRecord } from "../offboard.js";
import { asMutable } from "../readonly.js";
import { isDemoOrg, seedDemoOrg } from "../demo.js";
import { auditRetention } from "../observability.js";
import { roleOf } from "../org-claim.js";
import { assertOrgAccess, isOperator, sessionFromHeaders, type Session } from "../session.js";
import type { AppContext, OrgParams } from "./context.js";
import { problem, rejectSecrets, sendClean } from "./responses.js";

const ORG_ROUTE_PREFIX = "/v1/orgs/:orgId";
const NON_MUTATING_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEMO_CANNED_POSTS = new Set([
  "POST /scans",
  "POST /cost",
  "POST /commitments",
  "POST /budgets",
  "POST /alerts",
]);
const FORMAT_KEYWORDS = new Set(["pattern", "format"]);
const READ_ONLY_EXEMPT = new Set(["POST /offboard", "POST /schedule/tick", "POST /claim"]);

type AuthResult = { session: Session } | { error: string; detail?: string };

const authResults = new WeakMap<FastifyRequest, AuthResult>();

async function authenticate(ctx: AppContext, request: FastifyRequest): Promise<AuthResult> {
  if (ctx.identity) {
    return ctx.identity.authenticate(request.headers);
  }
  const session = sessionFromHeaders(request);
  return session ? { session: { ...session, via: "header" } } : { error: "missing_session" };
}

/** The session resolved for this request in onRequest; null when it carried none or an invalid one. */
export function sessionOf(request: FastifyRequest): Session | null {
  const result = authResults.get(request);
  return result && "session" in result ? result.session : null;
}

function unauthorized(ctx: AppContext, request: FastifyRequest, reply: FastifyReply) {
  if (!ctx.identity) {
    return problem(reply, 401, "Unauthorized");
  }
  const result = authResults.get(request);
  const error = result && "error" in result ? result.error : "missing_token";
  if (result && "detail" in result && result.detail) {
    request.log.info({ authError: error, detail: result.detail }, "bearer token rejected");
  }
  void reply.header(
    "www-authenticate",
    error === "missing_token" ? 'Bearer realm="farside"' : `Bearer realm="farside", error="invalid_token"`,
  );
  return problem(reply, 401, error === "header_session_disabled" ? "Header session disabled" : "Unauthorized", {
    error,
  });
}

function orgIdOf(request: FastifyRequest): string | undefined {
  return (request.params as Partial<OrgParams> | undefined)?.orgId;
}

function validationPath(issue: NonNullable<FastifyError["validation"]>[number]): string {
  const segments = issue.instancePath.split("/").filter(Boolean);
  const missing = (issue.params as { missingProperty?: string }).missingProperty;
  if (issue.keyword === "required" && missing) {
    segments.push(missing);
  }
  return segments.join(".");
}

export function operatorGuard(ctx: AppContext): preValidationAsyncHookHandler {
  return async (request, reply) => {
    const orgId = orgIdOf(request) ?? "";
    if (!isOperator(request, ctx.operatorToken) || isDemoOrg(orgId)) {
      return problem(reply, 403, "Forbidden");
    }
    const deletion = await ctx.store.deletion(orgId);
    if (deletion) {
      return problem(reply, 410, "Gone", { deletedAt: deletion.deletedAt });
    }
    return undefined;
  };
}

function rejectLocked(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  orgId: string,
  deletion: DeletionRecord | null,
  contract: Contract | null,
): boolean {
  if (deletion || NON_MUTATING_METHODS.has(request.method)) {
    return false;
  }
  const route = `${request.method} ${request.routeOptions.url?.replace(ORG_ROUTE_PREFIX, "") ?? ""}`;
  if (isDemoOrg(orgId)) {
    if (DEMO_CANNED_POSTS.has(route)) {
      return false;
    }
    void problem(reply, 403, "Demo is read-only");
    return true;
  }
  if (READ_ONLY_EXEMPT.has(route) || !isReadOnly(contract, ctx.clock())) {
    return false;
  }
  void problem(reply, 409, "Console read-only", {
    error: "console_read_only",
    attention: "scans paused",
  });
  return true;
}

function secretsRejected(request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  return request.routeOptions.config.rejectSecrets && rejectSecrets(request.body, reply)
    ? reply
    : undefined;
}

export const secretsGuard: preValidationAsyncHookHandler = async (request, reply) =>
  secretsRejected(request, reply);

function orgGate(ctx: AppContext): preValidationAsyncHookHandler {
  return async (request, reply) => {
    const orgId = orgIdOf(request);
    const config = request.routeOptions.config;
    if (!orgId || config.operator) {
      return undefined;
    }
    const session = sessionOf(request);
    if (!session) {
      return unauthorized(ctx, request, reply);
    }
    if (assertOrgAccess(session, orgId) !== "ok") {
      return problem(reply, 403, "Forbidden");
    }
    let deletion = await ctx.store.deletion(orgId);
    let contract: Contract | null = null;
    if (!deletion && !isDemoOrg(orgId) && (await ctx.store.hasOrg(orgId))) {
      contract = asMutable<Contract | null>((await ctx.store.read(orgId, "contract")).contract);
      if (contract && retentionElapsed(contract, ctx.clock())) {
        auditRetention(request.server.log.child({ reqId: request.id }), [
          await ctx.store.offboard(orgId, ctx.clock(), "retention"),
        ]);
        deletion = await ctx.store.deletion(orgId);
        contract = null;
      }
    }
    if (deletion && !config.allowDeleted) {
      return problem(reply, 410, "Gone", { deletedAt: deletion.deletedAt });
    }
    if (ctx.identity && !deletion && !config.claim && !isDemoOrg(orgId)) {
      const claim = await ctx.store.orgClaim(orgId);
      if (!roleOf(claim, session.actorId)) {
        return problem(reply, 403, "Forbidden", { error: claim ? "not_a_member" : "org_not_claimed" });
      }
    }
    if (isDemoOrg(orgId) && !deletion) {
      await seedDemoOrg(ctx.store);
    }
    if (rejectLocked(ctx, request, reply, orgId, deletion, contract)) {
      return reply;
    }
    return secretsRejected(request, reply);
  };
}

function demoShortcut(ctx: AppContext): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const orgId = orgIdOf(request);
    const demo = request.routeOptions.config.demo;
    if (!demo || !orgId || !isDemoOrg(orgId)) {
      return undefined;
    }
    const canned = await demo(ctx.store, orgId);
    return canned ? sendClean(reply, canned.status, canned.body) : problem(reply, 404, "Not found");
  };
}

export function registerHttp(app: FastifyInstance, ctx: AppContext): void {
  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
    const operator =
      request.routeOptions.config.operator === true && isOperator(request, ctx.operatorToken);
    const auth = await authenticate(ctx, request);
    authResults.set(request, auth);
    const session = "session" in auth ? auth.session : null;
    const actorId = operator ? "operator" : session?.actorId;
    const boundOrgId = orgIdOf(request) ?? session?.orgId;
    request.log = request.log.child({
      ...(boundOrgId ? { orgId: boundOrgId } : {}),
      ...(actorId ? { actorId } : {}),
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        route: request.routeOptions.url ?? "unmatched",
        method: request.method,
        status: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error.validation) {
      const context = error.validationContext ?? "body";
      const errors = error.validation.map((issue) => ({
        path: validationPath(issue) || context,
        message: FORMAT_KEYWORDS.has(issue.keyword)
          ? "invalid format"
          : (issue.message ?? "invalid"),
      }));
      const cloudRejected =
        context === "querystring" && errors.some((issue) => issue.path === "cloud");
      const title =
        context === "body"
          ? (request.routeOptions.config.invalidTitle ?? "Invalid request")
          : cloudRejected
            ? "Invalid cloud"
            : "Invalid request";
      return problem(reply, 400, title, { errors });
    }
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      return reply.send(error);
    }
    const errorId = randomUUID();
    request.log.error({ err: error, errorId }, "unhandled error");
    return reply.code(500).type("application/problem+json").send({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      errorId,
    });
  });

  app.addHook("preValidation", async (request) => {
    if (
      (request.body === undefined || request.body === null) &&
      request.routeOptions.schema?.body
    ) {
      request.body = {};
    }
  });
  app.addHook("preValidation", orgGate(ctx));
  app.addHook("preHandler", demoShortcut(ctx));
}
