import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export type Session = {
  orgId: string;
  actorId: string;
  /** Roles from the configured role claim; empty for the header stand-in. */
  roles?: readonly string[];
  /** How the session was established: the header stand-in, or a verified bearer token. */
  via?: "header" | "token";
};

export const ORG_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const ORG_ID = new RegExp(ORG_ID_PATTERN);

export const ORG_HEADER = "x-farside-org";
export const ACTOR_HEADER = "x-farside-actor";
export const OPERATOR_HEADER = "x-farside-operator";

// Header stand-in for local development and tests. When FARSIDE_IDENTITY_ISSUER is set,
// verified bearer tokens replace it (see identity.ts) and these headers are refused.
export function sessionFromHeaders(request: FastifyRequest): Session | null {
  const orgHeader = request.headers[ORG_HEADER];
  const orgId = Array.isArray(orgHeader) ? orgHeader[0] : orgHeader;
  if (typeof orgId !== "string" || !ORG_ID.test(orgId)) {
    return null;
  }
  const actorHeader = request.headers[ACTOR_HEADER];
  const actorRaw = Array.isArray(actorHeader) ? actorHeader[0] : actorHeader;
  return { orgId, actorId: typeof actorRaw === "string" && actorRaw.length > 0 ? actorRaw : "unknown" };
}

export function assertOrgAccess(session: Session, orgId: string): "ok" | "forbidden" {
  return session.orgId === orgId ? "ok" : "forbidden";
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isOperator(request: FastifyRequest, operatorToken: string | undefined): boolean {
  const header = request.headers[OPERATOR_HEADER];
  if (!operatorToken || typeof header !== "string") {
    return false;
  }
  return timingSafeEqual(digest(header), digest(operatorToken));
}
