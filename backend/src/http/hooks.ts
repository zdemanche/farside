import { randomUUID } from "node:crypto";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
  preValidationAsyncHookHandler,
} from "fastify";
import { isReadOnly } from "../billing.js";
import { isDemoOrg, seedDemoOrg } from "../demo.js";
import { auditRetention } from "../observability.js";
import { assertOrgAccess, isOperator, sessionFromHeaders } from "../session.js";
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
const READ_ONLY_EXEMPT = new Set(["POST /offboard", "POST /schedule/tick"]);

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
    const deletion = ctx.store.deletion(orgId);
    if (deletion) {
      return problem(reply, 410, "Gone", { deletedAt: deletion.deletedAt });
    }
    return undefined;
  };
}

function rejectLocked(ctx: AppContext, request: FastifyRequest, reply: FastifyReply, orgId: string): boolean {
  if (ctx.store.deletion(orgId) || NON_MUTATING_METHODS.has(request.method)) {
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
  if (READ_ONLY_EXEMPT.has(route) || !isReadOnly(ctx.store.snapshot(orgId).contract, ctx.clock())) {
    return false;
  }
  void problem(reply, 409, "Console read-only", {
    error: "console_read_only",
    attention: "scans paused",
  });
  return true;
}

function orgGate(ctx: AppContext): preValidationAsyncHookHandler {
  return async (request, reply) => {
    const orgId = orgIdOf(request);
    const config = request.routeOptions.config;
    if (!orgId || config.operator) {
      return undefined;
    }
    const session = sessionFromHeaders(request);
    if (session && assertOrgAccess(session, orgId) === "ok" && !ctx.store.deletion(orgId)) {
      auditRetention(
        request.server.log.child({ reqId: request.id }),
        ctx.store.sweepRetention(ctx.clock(), orgId),
      );
    }
    if (!session) {
      return problem(reply, 401, "Unauthorized");
    }
    if (assertOrgAccess(session, orgId) !== "ok") {
      return problem(reply, 403, "Forbidden");
    }
    const deletion = ctx.store.deletion(orgId);
    if (deletion && !config.allowDeleted) {
      return problem(reply, 410, "Gone", { deletedAt: deletion.deletedAt });
    }
    if (isDemoOrg(orgId) && !deletion) {
      seedDemoOrg(ctx.store);
    }
    if (rejectLocked(ctx, request, reply, orgId)) {
      return reply;
    }
    if (config.rejectSecrets && rejectSecrets(request.body, reply)) {
      return reply;
    }
    return undefined;
  };
}

function demoShortcut(ctx: AppContext): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const orgId = orgIdOf(request);
    const demo = request.routeOptions.config.demo;
    if (!demo || !orgId || !isDemoOrg(orgId)) {
      return undefined;
    }
    const canned = demo(ctx.store, orgId);
    return canned ? sendClean(reply, canned.status, canned.body) : problem(reply, 404, "Not found");
  };
}

export function registerHttp(app: FastifyInstance, ctx: AppContext): void {
  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
    const operator =
      request.routeOptions.config.operator === true && isOperator(request, ctx.operatorToken);
    const session = sessionFromHeaders(request);
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
      const errors = error.validation.map((issue) => ({
        path: validationPath(issue) || (error.validationContext ?? "body"),
        message: issue.message ?? "invalid",
      }));
      return problem(reply, 400, request.routeOptions.config.invalidTitle ?? "Invalid request", {
        errors,
      });
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
    if (request.body === undefined && request.routeOptions.schema?.body) {
      request.body = {};
    }
  });
  app.addHook("preValidation", orgGate(ctx));
  app.addHook("preHandler", demoShortcut(ctx));
}
