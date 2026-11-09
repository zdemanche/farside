import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { ORG_ID_PATTERN, type Session } from "./session.js";

/**
 * Bearer-token verification against a standard OIDC provider (E2-S1-T2, #48).
 *
 * Nothing here assumes how Moonaan Identity shapes its tokens: the issuer, audience,
 * JWKS location, client id and the org / actor / role claim names are configuration.
 */

export type IdentityAlgorithm = "RS256" | "ES256";

export type IdentityConfig = {
  issuer: string;
  audiences: readonly string[];
  /** JWKS endpoint. When absent, `jwks_uri` is read from `${issuer}/.well-known/openid-configuration`. */
  jwksUrl?: string | undefined;
  /** When set, a token that carries `azp` must name this client. */
  clientId?: string | undefined;
  orgClaim: string;
  actorClaim: string;
  roleClaim?: string | undefined;
  /** When set, only a token whose roles include this value may claim an unclaimed org. */
  claimRole?: string | undefined;
  algorithms: readonly IdentityAlgorithm[];
  clockToleranceSeconds: number;
  /** How long a fetched key set is trusted before it is fetched again. */
  jwksCacheSeconds: number;
};

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type IdentityOptions = IdentityConfig & {
  fetch?: FetchLike;
  /** Milliseconds since the epoch; tests pin it. */
  now?: () => number;
};

export type VerifiedToken = { header: Record<string, unknown>; payload: Record<string, unknown> };

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

const ALGORITHMS: Record<IdentityAlgorithm, { kty: string; crv?: string; dsaEncoding?: "ieee-p1363" }> = {
  RS256: { kty: "RSA" },
  ES256: { kty: "EC", crv: "P-256", dsaEncoding: "ieee-p1363" },
};
const DEFAULT_ALGORITHMS: IdentityAlgorithm[] = ["RS256", "ES256"];
const REFETCH_FLOOR_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const ORG_ID = new RegExp(ORG_ID_PATTERN);

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function seconds(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a whole number of seconds`);
  }
  return parsed;
}

/** Reads `FARSIDE_IDENTITY_*`. Returns undefined when no issuer is set, so the header session stays. */
export function identityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IdentityConfig | undefined {
  const issuer = env.FARSIDE_IDENTITY_ISSUER?.trim();
  if (!issuer) {
    return undefined;
  }
  const audiences = list(env.FARSIDE_IDENTITY_AUDIENCE);
  if (audiences.length === 0) {
    throw new Error("FARSIDE_IDENTITY_AUDIENCE is required when FARSIDE_IDENTITY_ISSUER is set");
  }
  const orgClaim = env.FARSIDE_IDENTITY_ORG_CLAIM?.trim();
  if (!orgClaim) {
    throw new Error("FARSIDE_IDENTITY_ORG_CLAIM is required when FARSIDE_IDENTITY_ISSUER is set");
  }
  const algorithms = list(env.FARSIDE_IDENTITY_ALGORITHMS);
  for (const alg of algorithms) {
    if (!(alg in ALGORITHMS)) {
      throw new Error(`FARSIDE_IDENTITY_ALGORITHMS: unsupported algorithm ${alg}`);
    }
  }
  return {
    issuer,
    audiences,
    jwksUrl: env.FARSIDE_IDENTITY_JWKS_URL?.trim() || undefined,
    clientId: env.FARSIDE_IDENTITY_CLIENT_ID?.trim() || undefined,
    orgClaim,
    actorClaim: env.FARSIDE_IDENTITY_ACTOR_CLAIM?.trim() || "sub",
    roleClaim: env.FARSIDE_IDENTITY_ROLE_CLAIM?.trim() || undefined,
    claimRole: env.FARSIDE_IDENTITY_CLAIM_ROLE?.trim() || undefined,
    algorithms: algorithms.length > 0 ? (algorithms as IdentityAlgorithm[]) : DEFAULT_ALGORITHMS,
    clockToleranceSeconds: seconds(env.FARSIDE_IDENTITY_CLOCK_TOLERANCE_SECONDS, 60, "FARSIDE_IDENTITY_CLOCK_TOLERANCE_SECONDS"),
    jwksCacheSeconds: seconds(env.FARSIDE_IDENTITY_JWKS_CACHE_SECONDS, 600, "FARSIDE_IDENTITY_JWKS_CACHE_SECONDS"),
  };
}

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new TokenError(`malformed ${what}`);
}

type CachedKeys = { keys: Map<string | undefined, JsonWebKey[]>; fetchedAt: number };

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** Fetches and caches a JWKS. An unknown `kid` refetches, at most once per 30 seconds, to follow key rotation. */
export class JwksCache {
  #cached: CachedKeys | undefined;
  #inflight: Promise<CachedKeys> | undefined;
  #lastFetch = Number.NEGATIVE_INFINITY;
  #jwksUrl: string | undefined;

  constructor(
    private readonly config: Pick<IdentityConfig, "issuer" | "jwksUrl" | "jwksCacheSeconds">,
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly now: () => number = Date.now,
  ) {
    this.#jwksUrl = config.jwksUrl;
  }

  async #getJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new TokenError(`could not fetch ${url}: ${response.status}`);
    }
    return response.json();
  }

  async #jwksUri(): Promise<string> {
    if (this.#jwksUrl) {
      return this.#jwksUrl;
    }
    const discovery = (await this.#getJson(
      `${this.config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    )) as { jwks_uri?: unknown; issuer?: unknown };
    if (typeof discovery.jwks_uri !== "string") {
      throw new TokenError("discovery document has no jwks_uri");
    }
    this.#jwksUrl = discovery.jwks_uri;
    return this.#jwksUrl;
  }

  async #fetchKeys(): Promise<CachedKeys> {
    this.#lastFetch = this.now();
    const body = (await this.#getJson(await this.#jwksUri())) as { keys?: unknown };
    if (!Array.isArray(body.keys)) {
      throw new TokenError("JWKS has no keys");
    }
    const keys = new Map<string | undefined, JsonWebKey[]>();
    for (const key of body.keys as JsonWebKey[]) {
      if (typeof key !== "object" || key === null || (key.use !== undefined && key.use !== "sig")) {
        continue;
      }
      const kid = typeof key.kid === "string" ? key.kid : undefined;
      keys.set(kid, [...(keys.get(kid) ?? []), key]);
    }
    const cached = { keys, fetchedAt: this.now() };
    this.#cached = cached;
    return cached;
  }

  #refresh(): Promise<CachedKeys> {
    this.#inflight ??= this.#fetchKeys().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async keysFor(kid: string | undefined): Promise<JsonWebKey[]> {
    const fresh =
      this.#cached && this.now() - this.#cached.fetchedAt < this.config.jwksCacheSeconds * 1000
        ? this.#cached
        : await this.#refresh();
    const pick = (set: CachedKeys) =>
      kid === undefined ? [...set.keys.values()].flat() : (set.keys.get(kid) ?? []);
    const found = pick(fresh);
    if (found.length > 0 || this.now() - this.#lastFetch < REFETCH_FLOOR_MS) {
      return found;
    }
    return pick(await this.#refresh());
  }
}

function keyObject(jwk: JsonWebKey): KeyObject | undefined {
  try {
    return createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return undefined;
  }
}

function hasAudience(aud: unknown, accepted: readonly string[]): boolean {
  const values = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  return values.some((value) => typeof value === "string" && accepted.includes(value));
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

/** Verifies an RS256 / ES256 JWT's signature against the JWKS, then iss, aud, exp, nbf and azp. */
export function createVerifier(options: IdentityOptions): TokenVerifier {
  const now = options.now ?? Date.now;
  const jwks = new JwksCache(options, options.fetch, now);
  return async (token) => {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new TokenError("not a compact JWS");
    }
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeSegment(headerPart, "header");
    const alg = header.alg;
    if (typeof alg !== "string" || !options.algorithms.includes(alg as IdentityAlgorithm)) {
      throw new TokenError(`algorithm ${String(alg)} is not accepted`);
    }
    const spec = ALGORITHMS[alg as IdentityAlgorithm];
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const candidates = (await jwks.keysFor(kid)).filter(
      (jwk) =>
        jwk.kty === spec.kty &&
        (spec.crv === undefined || jwk.crv === spec.crv) &&
        (jwk.alg === undefined || jwk.alg === alg),
    );
    const signed = Buffer.from(`${headerPart}.${payloadPart}`);
    const signature = Buffer.from(signaturePart, "base64url");
    const valid = candidates.some((jwk) => {
      const key = keyObject(jwk);
      return (
        key !== undefined &&
        verify("sha256", signed, spec.dsaEncoding ? { key, dsaEncoding: spec.dsaEncoding } : key, signature)
      );
    });
    if (!valid) {
      throw new TokenError(candidates.length === 0 ? "no matching signing key" : "bad signature");
    }
    const payload = decodeSegment(payloadPart, "payload");
    const nowSeconds = now() / 1000;
    const tolerance = options.clockToleranceSeconds;
    if (payload.iss !== options.issuer) {
      throw new TokenError("unexpected issuer");
    }
    if (!hasAudience(payload.aud, options.audiences)) {
      throw new TokenError("unexpected audience");
    }
    if (typeof payload.exp !== "number" || payload.exp + tolerance <= nowSeconds) {
      throw new TokenError("token expired");
    }
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - tolerance > nowSeconds)) {
      throw new TokenError("token not yet valid");
    }
    if (options.clientId && payload.azp !== undefined && payload.azp !== options.clientId) {
      throw new TokenError("unexpected authorized party");
    }
    return { header, payload };
  };
}

/** Reads a claim by its exact name first (URL-style names contain dots), then as a dotted path. */
export function claimValue(payload: Record<string, unknown>, name: string): unknown {
  if (name in payload) {
    return payload[name];
  }
  let current: unknown = payload;
  for (const segment of name.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function rolesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/[\s,]+/).filter(Boolean);
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Maps the configured claims onto the existing Session. Null when the org or actor claim is unusable. */
export function sessionFromClaims(config: IdentityConfig, payload: Record<string, unknown>): Session | null {
  const orgId = claimValue(payload, config.orgClaim);
  const actorId = claimValue(payload, config.actorClaim);
  if (typeof orgId !== "string" || !ORG_ID.test(orgId) || typeof actorId !== "string" || actorId.length === 0) {
    return null;
  }
  return {
    orgId,
    actorId,
    roles: config.roleClaim ? rolesOf(claimValue(payload, config.roleClaim)) : [],
    via: "token",
  };
}

export type Authenticator = (headers: Record<string, string | string[] | undefined>) => Promise<
  { session: Session } | { error: "missing_token" | "header_session_disabled" | "invalid_token"; detail?: string }
>;

/** Resolves a request's session from its bearer token. The x-farside-org / x-farside-actor stand-in is refused. */
export function createAuthenticator(options: IdentityOptions, verifier: TokenVerifier = createVerifier(options)): Authenticator {
  return async (headers) => {
    if (headers["x-farside-org"] !== undefined || headers["x-farside-actor"] !== undefined) {
      return { error: "header_session_disabled" };
    }
    const raw = headers.authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = typeof value === "string" ? /^Bearer\s+([A-Za-z0-9._~+/-]+=*)\s*$/i.exec(value) : null;
    if (!match?.[1]) {
      return { error: "missing_token" };
    }
    try {
      const { payload } = await verifier(match[1]);
      const session = sessionFromClaims(options, payload);
      return session ? { session } : { error: "invalid_token", detail: "missing org or actor claim" };
    } catch (error) {
      return { error: "invalid_token", detail: error instanceof Error ? error.message : "invalid token" };
    }
  };
}
