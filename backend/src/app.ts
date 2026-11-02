import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { validateInventory, type Inventory } from "@farside/scan-contracts";
import { noOwnerTotal } from "./inventory.js";
import { SecretLeakError, assertNoSecrets } from "./secrets.js";
import { assertOrgAccess, sessionFromHeaders, type Session } from "./session.js";
import { MemoryStore } from "./store.js";

export const SERVICE_NAME = "farside";

type OrgParams = { orgId: string };
type ConnectionParams = { orgId: string; connectionId: string };

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank",
    title,
    status,
    ...extra,
  });
}

function requireOrg(
  request: FastifyRequest<{ Params: OrgParams }>,
  reply: FastifyReply,
): Session | null {
  const session = sessionFromHeaders(request);
  if (!session) {
    void problem(reply, 401, "Unauthorized");
    return null;
  }
  if (assertOrgAccess(session, request.params.orgId) !== "ok") {
    void problem(reply, 403, "Forbidden");
    return null;
  }
  return session;
}

function rejectSecrets(body: unknown, reply: FastifyReply): boolean {
  try {
    assertNoSecrets(body);
    return false;
  } catch (error) {
    if (error instanceof SecretLeakError) {
      void problem(reply, 400, "Secret rejected", {
        errors: [{ path: error.message, message: "secret or token pattern" }],
      });
      return true;
    }
    throw error;
  }
}

function sendClean(reply: FastifyReply, status: number, body: unknown) {
  assertNoSecrets(body);
  return reply.code(status).send(body);
}

function connectionInput(body: unknown): { tenantId: string; subscriptionId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.tenantId !== "string" || record.tenantId.length === 0) {
    return null;
  }
  if (typeof record.subscriptionId !== "string" || record.subscriptionId.length === 0) {
    return null;
  }
  return { tenantId: record.tenantId, subscriptionId: record.subscriptionId };
}

export function buildApp(store: MemoryStore = new MemoryStore()) {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    status: "ok" as const,
    service: SERVICE_NAME,
  }));

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    const inventory = store.snapshot(request.params.orgId).inventory;
    if (!inventory) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, inventory);
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory/no-owner", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    const inventory = store.snapshot(request.params.orgId).inventory;
    if (!inventory) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, noOwnerTotal(inventory));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/connections", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    return sendClean(reply, 200, { connections: store.snapshot(request.params.orgId).connections });
  });

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/connections", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    const input = connectionInput(request.body);
    if (!input) {
      return problem(reply, 400, "Invalid connection", {
        errors: [{ path: "body", message: "tenantId and subscriptionId are required" }],
      });
    }
    const connection = store.putConnection(request.params.orgId, input);
    return sendClean(reply, 201, connection);
  });

  app.delete<{ Params: ConnectionParams }>(
    "/v1/orgs/:orgId/connections/:connectionId",
    async (request, reply) => {
      if (!requireOrg(request, reply)) {
        return reply;
      }
      if (!store.deleteConnection(request.params.orgId, request.params.connectionId)) {
        return problem(reply, 404, "Not found");
      }
      return reply.code(204).send();
    },
  );

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    const errors = validateInventory(request.body);
    if (errors.length > 0) {
      return problem(reply, 400, "Invalid inventory", { errors });
    }
    const stored = store.putInventory(request.params.orgId, request.body as Inventory);
    return sendClean(reply, 200, stored);
  });

  return app;
}
