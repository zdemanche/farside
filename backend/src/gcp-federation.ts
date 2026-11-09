import { readFile } from "node:fs/promises";

/**
 * GCP Workload Identity Federation: an external OIDC token is exchanged at Google STS for a
 * federated token, which impersonates the customer-granted service account through IAM
 * Credentials generateAccessToken. Nothing is stored; the access token lives in memory until
 * shortly before it expires.
 *
 * Shapes follow Google's public REST reference and have NOT been run against a live project.
 * Tokens are never logged, never put in error messages, and only sent to the two Google origins.
 */
export const STS_TOKEN_URL = "https://sts.googleapis.com/v1/token";
export const IAM_CREDENTIALS_ORIGIN = "https://iamcredentials.googleapis.com";
export const READ_ONLY_SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";
export const FEDERATION_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
export const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIFETIME_SECONDS = 3600;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type SubjectTokenSource = () => Promise<string>;
export type GcpTokenProvider = () => Promise<string>;

export type GcpFederationConfig = {
  /** Number of the project that holds the workload identity pool. */
  poolProjectNumber: string;
  poolId: string;
  providerId: string;
  /** The customer-granted service account to impersonate. */
  serviceAccount: string;
  subjectToken: SubjectTokenSource;
  subjectTokenType?: string;
  scopes?: readonly string[];
  lifetimeSeconds?: number;
  fetch?: FetchLike;
  now?: () => Date;
};

/** STS or IAM Credentials refused the exchange. Carries only the step and HTTP status. */
export class GcpFederationError extends Error {
  constructor(
    readonly step: "subject_token" | "sts" | "impersonation",
    readonly status: number | null,
  ) {
    super(
      `GCP federated credential exchange failed at ${step}${status === null ? "" : ` (HTTP ${status})`}`,
    );
    this.name = "GcpFederationError";
  }
}

const PROJECT_NUMBER = /^\d{1,20}$/;
const POOL_OR_PROVIDER_ID = /^[a-z0-9-]{4,32}$/;
const SERVICE_ACCOUNT =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

export function federationAudience(
  config: Pick<GcpFederationConfig, "poolProjectNumber" | "poolId" | "providerId">,
): string {
  if (
    !PROJECT_NUMBER.test(config.poolProjectNumber) ||
    !POOL_OR_PROVIDER_ID.test(config.poolId) ||
    !POOL_OR_PROVIDER_ID.test(config.providerId)
  ) {
    throw new Error("workload identity pool project number, pool id or provider id is malformed");
  }
  return `//iam.googleapis.com/projects/${config.poolProjectNumber}/locations/global/workloadIdentityPools/${config.poolId}/providers/${config.providerId}`;
}

export function impersonationUrl(serviceAccount: string): string {
  if (!SERVICE_ACCOUNT.test(serviceAccount)) {
    throw new Error("service account must be a <name>@<project>.iam.gserviceaccount.com email");
  }
  return `${IAM_CREDENTIALS_ORIGIN}/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`;
}

/** Reads an OIDC token file on every exchange, so a rotated file is picked up. */
export function fileSubjectToken(
  path: string,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): SubjectTokenSource {
  return async () => {
    let token: string;
    try {
      token = (await read(path)).trim();
    } catch {
      throw new GcpFederationError("subject_token", null);
    }
    if (token.length === 0) {
      throw new GcpFederationError("subject_token", null);
    }
    return token;
  };
}

async function post(
  call: FetchLike,
  url: string,
  step: "sts" | "impersonation",
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await call(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    // The underlying error can echo request details; report only the step.
    throw new GcpFederationError(step, null);
  }
  if (!response.ok) {
    throw new GcpFederationError(step, response.status);
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== "object") {
    throw new GcpFederationError(step, response.status);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Returns a token provider that caches the impersonated access token until
 * TOKEN_REFRESH_SKEW_MS before expiry. Concurrent callers share one exchange.
 */
export function gcpFederatedTokenProvider(config: GcpFederationConfig): GcpTokenProvider {
  const audience = federationAudience(config);
  const target = impersonationUrl(config.serviceAccount);
  const scopes = config.scopes ?? [READ_ONLY_SCOPE];
  const lifetime = config.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime < 300 || lifetime > 3600) {
    throw new Error("token lifetime must be 300 to 3600 seconds");
  }
  const call = config.fetch ?? ((input, init) => fetch(input, init));
  const now = config.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function exchange(): Promise<string> {
    const subject = await config.subjectToken();
    const sts = await post(
      call,
      STS_TOKEN_URL,
      "sts",
      {},
      {
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience,
        scope: FEDERATION_SCOPE,
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        subjectToken: subject,
        subjectTokenType: config.subjectTokenType ?? JWT_TOKEN_TYPE,
      },
    );
    const federated = sts.access_token;
    if (typeof federated !== "string" || federated.length === 0) {
      throw new GcpFederationError("sts", null);
    }
    const issued = await post(
      call,
      target,
      "impersonation",
      { authorization: `Bearer ${federated}` },
      { scope: scopes, lifetime: `${lifetime}s` },
    );
    const token = issued.accessToken;
    const expireTime =
      typeof issued.expireTime === "string" ? Date.parse(issued.expireTime) : Number.NaN;
    if (typeof token !== "string" || token.length === 0 || !Number.isFinite(expireTime)) {
      throw new GcpFederationError("impersonation", null);
    }
    cached = { token, expiresAt: expireTime };
    return token;
  }

  return async () => {
    if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now().getTime()) {
      return cached.token;
    }
    if (!inflight) {
      inflight = exchange().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}
