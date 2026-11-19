import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "./http/context.js";
import { sessionOf } from "./http/hooks.js";
import { problem } from "./http/responses.js";
import type { IdentityConfig } from "./identity.js";
import { roleOf } from "./org-claim.js";

/**
 * Opt-in hardening for Identity mode. With neither variable set nothing here changes behaviour.
 *
 * FARSIDE_REQUIRE_IDENTITY=1 refuses to start without FARSIDE_IDENTITY_*. Without Identity the API trusts the
 * x-farside-org and x-farside-actor headers, so a deploy that misses the issuer would let any caller act as any org.
 *
 * FARSIDE_OWNER_ONLY_DESTRUCTIVE=1 limits offboarding and connection changes to the org's owner. Any verified user of
 * the tenant can otherwise join the org through POST /claim and then offboard it.
 */
export const REQUIRE_IDENTITY_ENV = "FARSIDE_REQUIRE_IDENTITY";
export const OWNER_ONLY_ENV = "FARSIDE_OWNER_ONLY_DESTRUCTIVE";

export class IdentityRequiredError extends Error {
  constructor() {
    super(`${REQUIRE_IDENTITY_ENV}=1 but FARSIDE_IDENTITY_ISSUER is not set`);
    this.name = "IdentityRequiredError";
  }
}

/** Throws when Identity is required and missing. In production without Identity it warns once, and changes nothing. */
export function assertIdentityPolicy(
  env: NodeJS.Dict<string>,
  identity: IdentityConfig | undefined,
  warn: (message: string) => void = (message) => process.emitWarning(message),
): void {
  if (identity) {
    return;
  }
  if (env[REQUIRE_IDENTITY_ENV] === "1") {
    throw new IdentityRequiredError();
  }
  if (env.NODE_ENV === "production") {
    warn(
      `Identity is not configured, so the API trusts the x-farside-org header. Set FARSIDE_IDENTITY_ISSUER, or ${REQUIRE_IDENTITY_ENV}=1 to refuse to start without it.`,
    );
  }
}

export function ownerOnlyEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env[OWNER_ONLY_ENV] === "1";
}

/** True when the caller may proceed. Otherwise a 403 is already sent and the handler must return the reply. */
export async function requireOwner(
  ctx: AppContext,
  request: FastifyRequest<{ Params: { orgId: string } }>,
  reply: FastifyReply,
  env: NodeJS.Dict<string> = process.env,
): Promise<boolean> {
  if (!ownerOnlyEnabled(env)) {
    return true;
  }
  const actorId = sessionOf(request)?.actorId;
  const claim = await ctx.store.orgClaim(request.params.orgId);
  if (actorId && roleOf(claim, actorId) === "owner") {
    return true;
  }
  void problem(reply, 403, "Forbidden", { error: "owner_only" });
  return false;
}
