import { readFile } from "node:fs/promises";
import { REQUEST_TIMEOUT_MS, type FetchLike, type TokenProvider } from "./azure-live.js";

/**
 * Secretless ARM tokens for a customer tenant (E2-S2-T1, #53).
 *
 * Entra workload identity federation: Farside's multi-tenant app has a federated credential
 * that trusts an OIDC token its own runtime can present (an AWS-issued web identity token, a
 * Kubernetes service account token, a GitHub Actions token). That token is sent as
 * `client_assertion` in a `client_credentials` grant against the customer's tenant. No client
 * secret or certificate exists anywhere.
 *
 * Shapes follow Microsoft's public reference and have NOT been run against a live tenant.
 * The access token and the assertion are never logged, stored, or put in an error message.
 */
export const ENTRA_ORIGIN = "https://login.microsoftonline.com";
export const ARM_SCOPE = "https://management.azure.com/.default";
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

/** First set wins. The file is re-read on every exchange because the runtime rotates it. */
export const ASSERTION_FILE_ENV = [
  "FARSIDE_AZURE_ASSERTION_FILE",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
] as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;

export type AssertionSource = () => Promise<string>;

export class FederatedExchangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Entra refused the federated token exchange (HTTP ${status}${code ? `, ${code}` : ""})`);
    this.name = "FederatedExchangeError";
  }
}

export function isGuid(value: string): boolean {
  return GUID.test(value);
}

export function isTenantId(value: string): boolean {
  return GUID.test(value) || TENANT_DOMAIN.test(value);
}

function assertJwt(value: string, what: string): string {
  if (!JWT.test(value)) {
    throw new Error(`${what} is not a JWT`);
  }
  return value;
}

export function fileAssertionSource(
  path: string,
  read: (path: string) => Promise<string> = (file) => readFile(file, "utf8"),
): AssertionSource {
  return async () => assertJwt((await read(path)).trim(), "federated assertion file");
}

export function assertionFileFromEnv(env: NodeJS.Dict<string>): string | null {
  for (const name of ASSERTION_FILE_ENV) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/** Only the claims Farside reads. The signature is not checked: Azure checks it, we only route. */
export function accessTokenClaims(token: string): { tid: string | null; oid: string | null } {
  const payload = token.split(".")[1];
  if (!payload) {
    return { tid: null, oid: null };
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const pick = (key: string) => (typeof claims[key] === "string" ? (claims[key] as string) : null);
    return { tid: pick("tid"), oid: pick("oid") };
  } catch {
    return { tid: null, oid: null };
  }
}

type TokenBody = {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_codes?: unknown;
};

function refusalCode(body: TokenBody): string | null {
  const first = Array.isArray(body.error_codes) ? body.error_codes[0] : undefined;
  if (typeof first === "number" && Number.isInteger(first)) {
    return `AADSTS${first}`;
  }
  return typeof body.error === "string" && ERROR_CODE.test(body.error) ? body.error : null;
}

async function readBody(response: Response): Promise<TokenBody> {
  try {
    const body = (await response.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as TokenBody) : {};
  } catch {
    return {};
  }
}

export type FederatedTokenOptions = {
  tenantId: string;
  clientId: string;
  assertion: AssertionSource;
  fetch?: FetchLike;
  now?: () => number;
  scope?: string;
};

/**
 * A TokenProvider for one customer tenant. Tokens are cached in memory until five minutes
 * before expiry, and concurrent callers share one exchange.
 */
export function federatedTokenProvider(options: FederatedTokenOptions): TokenProvider {
  if (!isTenantId(options.tenantId)) {
    throw new Error("tenant id must be a GUID or a tenant domain");
  }
  if (!isGuid(options.clientId)) {
    throw new Error("client id must be a GUID");
  }
  const now = options.now ?? Date.now;
  const call = options.fetch ?? ((input, init) => fetch(input, init));
  const url = `${ENTRA_ORIGIN}/${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`;
  let cached: { token: string; refreshAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function exchange(): Promise<string> {
    const form = new URLSearchParams({
      client_id: options.clientId,
      scope: options.scope ?? ARM_SCOPE,
      grant_type: "client_credentials",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await options.assertion(),
    });
    const response = await call(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new FederatedExchangeError(response.status, refusalCode(body));
    }
    const lifetime = typeof body.expires_in === "string" ? Number(body.expires_in) : body.expires_in;
    if (
      typeof body.access_token !== "string" ||
      body.access_token.length === 0 ||
      typeof body.token_type !== "string" ||
      body.token_type.toLowerCase() !== "bearer" ||
      typeof lifetime !== "number" ||
      !Number.isFinite(lifetime) ||
      lifetime <= 0
    ) {
      throw new FederatedExchangeError(502, "malformed_token_response");
    }
    const lifetimeMs = lifetime * 1000;
    cached = {
      token: body.access_token,
      refreshAt: now() + lifetimeMs - Math.min(REFRESH_BEFORE_EXPIRY_MS, lifetimeMs / 2),
    };
    return body.access_token;
  }

  return async () => {
    if (cached && now() < cached.refreshAt) {
      return cached.token;
    }
    inflight ??= exchange().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

/** One cached provider per customer tenant, all using Farside's single app registration. */
export function federatedTokenProviders(
  options: Omit<FederatedTokenOptions, "tenantId">,
): (tenantId: string) => TokenProvider {
  const byTenant = new Map<string, TokenProvider>();
  return (tenantId) => {
    const key = tenantId.toLowerCase();
    let provider = byTenant.get(key);
    if (!provider) {
      provider = federatedTokenProvider({ ...options, tenantId });
      byTenant.set(key, provider);
    }
    return provider;
  };
}
