import type { FastifyReply, FastifyRequest } from "fastify";
import { matchesCloud, type Cloud } from "../cloud.js";
import { audit } from "../observability.js";
import { ProviderNotConfiguredError } from "../providers/unconfigured.js";
import { SecretLeakError, assertNoSecrets, isVerified } from "../secrets.js";
import type { OrgRepository } from "../repository.js";
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
  return reply
    .code(status)
    .type("application/problem+json")
    .send({
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

export function sendStored(reply: FastifyReply, status: number, body: unknown) {
  if (!isVerified(body)) {
    assertNoSecrets(body);
  }
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

export function cloudOf(query: unknown): Cloud | undefined {
  return (query as { cloud?: Cloud | "" }).cloud || undefined;
}

export function cloudFilter<T>(
  rows: readonly T[],
  cloud: Cloud | undefined,
  cloudOf: (row: T) => Cloud,
): T[] {
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

export async function connectedSubscription(
  store: OrgRepository,
  orgId: string,
  subscriptionId: string,
): Promise<string | null> {
  const wanted = subscriptionId.toLowerCase();
  const { connections } = await store.read(orgId, "connections");
  const match = connections.find((connection) => connection.subscriptionId.toLowerCase() === wanted);
  return match?.subscriptionId ?? null;
}

export async function requireConnected(
  ctx: AppContext,
  request: FastifyRequest<{ Params: { orgId: string } }>,
  reply: FastifyReply,
  subscriptionId: string,
  title: string,
): Promise<string | null> {
  const connected = await connectedSubscription(ctx.store, request.params.orgId, subscriptionId);
  if (!connected) {
    void problem(reply, 400, title, {
      errors: [{ path: "subscriptionId", message: "not a connected subscription" }],
    });
  }
  return connected;
}
