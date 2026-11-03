import type { FastifyReply, FastifyRequest } from "fastify";
import { matchesCloud, parseCloudQuery, type Cloud } from "../cloud.js";
import { audit } from "../observability.js";
import { ProviderNotConfiguredError } from "../providers/unconfigured.js";
import { SecretLeakError, assertNoSecrets } from "../secrets.js";
import type { MemoryStore } from "../store.js";
import type { AppContext } from "./context.js";

const AUDITED_STATUSES = new Set([401, 403, 409]);

export function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
) {
  if (AUDITED_STATUSES.has(status)) {
    audit(reply.request.log, `http.${status}`, { title });
  }
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank",
    title,
    status,
    ...extra,
  });
}

export function sendClean(reply: FastifyReply, status: number, body: unknown) {
  assertNoSecrets(body);
  return reply.code(status).send(body);
}

export function rejectSecrets(body: unknown, reply: FastifyReply): boolean {
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

export function readCloud(
  query: unknown,
  reply: FastifyReply,
): { ok: true; cloud?: Cloud } | { ok: false } {
  const parsed = parseCloudQuery((query ?? {}) as Record<string, unknown>);
  if (parsed.error) {
    void problem(reply, 400, "Invalid cloud", {
      errors: [{ path: "cloud", message: parsed.error }],
    });
    return { ok: false };
  }
  return parsed.cloud ? { ok: true, cloud: parsed.cloud } : { ok: true };
}

export function cloudFilter<T>(rows: T[], cloud: Cloud | undefined, cloudOf: (row: T) => Cloud): T[] {
  return rows.filter((row) => matchesCloud(cloudOf(row), cloud));
}

export async function withProvider<T>(
  reply: FastifyReply,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      void problem(reply, 503, error.message);
      return { ok: false };
    }
    throw error;
  }
}

export function connectedSubscription(
  store: MemoryStore,
  orgId: string,
  subscriptionId: string,
): string | null {
  const wanted = subscriptionId.toLowerCase();
  const match = store
    .snapshot(orgId)
    .connections.find((connection) => connection.subscriptionId.toLowerCase() === wanted);
  return match?.subscriptionId ?? null;
}

export function requireConnected(
  ctx: AppContext,
  request: FastifyRequest<{ Params: { orgId: string } }>,
  reply: FastifyReply,
  subscriptionId: string,
  title: string,
): string | null {
  const connected = connectedSubscription(ctx.store, request.params.orgId, subscriptionId);
  if (!connected) {
    void problem(reply, 400, title, {
      errors: [{ path: "subscriptionId", message: "not a connected subscription" }],
    });
  }
  return connected;
}
