import type { FastifyRequest } from "fastify";

export type Session = {
  orgId: string;
  actorId: string;
};

export const ORG_HEADER = "x-farside-org";
export const ACTOR_HEADER = "x-farside-actor";

// TODO: E2-S1-T2 Moonaan Identity tokens replace these headers.
export function sessionFromHeaders(request: FastifyRequest): Session | null {
  const orgHeader = request.headers[ORG_HEADER];
  const orgId = Array.isArray(orgHeader) ? orgHeader[0] : orgHeader;
  if (typeof orgId !== "string" || orgId.length === 0) {
    return null;
  }
  const actorHeader = request.headers[ACTOR_HEADER];
  const actorRaw = Array.isArray(actorHeader) ? actorHeader[0] : actorHeader;
  return { orgId, actorId: typeof actorRaw === "string" && actorRaw.length > 0 ? actorRaw : "unknown" };
}

export function assertOrgAccess(session: Session, orgId: string): "ok" | "forbidden" {
  return session.orgId === orgId ? "ok" : "forbidden";
}
