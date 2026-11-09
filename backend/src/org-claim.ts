/**
 * Org claim (E2-S1, #46 / #49): the first verified user of a tenant claims the org and
 * becomes its owner; later users of the same tenant join it as members. Claiming again is
 * a no-op that returns the caller's existing role.
 */

export type OrgRole = "owner" | "member";

export type OrgMember = { actorId: string; role: OrgRole; joinedAt: string };

export type OrgClaim = {
  orgId: string;
  ownerId: string;
  claimedAt: string;
  members: OrgMember[];
};

export type ClaimOutcome = "claimed" | "joined" | "existing";

export type ClaimResult =
  | { outcome: ClaimOutcome; claim: OrgClaim; role: OrgRole }
  /** The org is unclaimed and the caller may not become its owner. */
  | { outcome: "refused"; claim: null; role: null };

export type ClaimOptions = {
  /** False when the caller lacks the configured claim role; they may then only join a claimed org. */
  mayOwn?: boolean;
};

export const MAX_ORG_MEMBERS = 1000;

export class MemberLimitError extends Error {
  constructor(orgId: string) {
    super(`org ${orgId} already has ${MAX_ORG_MEMBERS} members`);
    this.name = "MemberLimitError";
  }
}

export function roleOf(claim: OrgClaim | null, actorId: string): OrgRole | null {
  return claim?.members.find((member) => member.actorId === actorId)?.role ?? null;
}

/**
 * Pure transition shared by every store. Returns the claim to write, or `write: false`
 * when nothing changes (an existing member, or a refused claim).
 */
export function nextClaim(
  current: OrgClaim | null,
  input: { orgId: string; actorId: string; now: string; mayOwn: boolean },
): { result: ClaimResult; write: boolean } {
  if (!current) {
    if (!input.mayOwn) {
      return { result: { outcome: "refused", claim: null, role: null }, write: false };
    }
    const claim: OrgClaim = {
      orgId: input.orgId,
      ownerId: input.actorId,
      claimedAt: input.now,
      members: [{ actorId: input.actorId, role: "owner", joinedAt: input.now }],
    };
    return { result: { outcome: "claimed", claim, role: "owner" }, write: true };
  }
  const existing = roleOf(current, input.actorId);
  if (existing) {
    return { result: { outcome: "existing", claim: current, role: existing }, write: false };
  }
  if (current.members.length >= MAX_ORG_MEMBERS) {
    throw new MemberLimitError(input.orgId);
  }
  const claim: OrgClaim = {
    ...current,
    members: [...current.members, { actorId: input.actorId, role: "member", joinedAt: input.now }],
  };
  return { result: { outcome: "joined", claim, role: "member" }, write: true };
}

/** What the API shows a caller about their org's claim. Member ids stay private to the store. */
export function claimView(orgId: string, claim: OrgClaim | null, actorId: string) {
  const role = roleOf(claim, actorId);
  return {
    orgId,
    claimed: claim !== null,
    claimedAt: claim?.claimedAt ?? null,
    role,
    member: role !== null,
    owner: claim ? claim.ownerId === actorId : false,
    memberCount: claim?.members.length ?? 0,
  };
}
