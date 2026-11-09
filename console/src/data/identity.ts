/**
 * Console sign-in against a standard OIDC provider (E2-S1-T3, #49): authorization code
 * flow with PKCE (S256). Every provider detail is a Vite env var; nothing assumes how
 * Moonaan Identity names its endpoints or claims.
 *
 * The token lives in sessionStorage (or memory when storage is blocked) and is sent as a
 * bearer by `data/api.ts`. It is never written to localStorage.
 */

export type IdentityConfig = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  /** Sent as `audience` on the authorize request when the provider needs it. */
  audience?: string;
  /** Token claim that names the organisation; falls back to VITE_FARSIDE_ORG. */
  orgClaim?: string;
  /** Skip discovery when both are set. */
  authorizeUrl?: string;
  tokenUrl?: string;
  providerName: string;
};

export type IdentitySession = {
  token: string;
  /** Milliseconds since the epoch, or null when the token carries no exp. */
  expiresAt: number | null;
  orgId: string | null;
  name: string | null;
};

export type KeyValueStore = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

export type IdentityRuntime = {
  config: IdentityConfig;
  apiUrl: string;
  fallbackOrgId?: string;
  fetch?: typeof fetch;
  storage?: KeyValueStore;
  /** Leaves the console for the provider; window.location.assign by default. */
  navigate?: (url: string) => void;
  currentUrl?: () => string;
  replaceUrl?: (url: string) => void;
  now?: () => number;
};

type Env = Record<string, string | boolean | undefined>;

export const SESSION_KEY = "farside.identity.session";
export const PKCE_KEY = "farside.identity.pkce";
const DEFAULT_SCOPE = "openid profile email";
const DEFAULT_PROVIDER = "Moonaan Identity";

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

const text = (env: Env, key: string): string | undefined => {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/** Identity is on only when issuer, client id and API URL are all set and demo mode is off. */
export function identityFromEnv(
  env: Env,
  location: { origin: string; pathname: string },
): IdentityRuntime | null {
  const issuer = text(env, "VITE_FARSIDE_IDENTITY_ISSUER");
  const clientId = text(env, "VITE_FARSIDE_IDENTITY_CLIENT_ID");
  const apiUrl = text(env, "VITE_FARSIDE_API_URL");
  if (!issuer || !clientId || !apiUrl || env.VITE_FARSIDE_DEMO === "1") {
    return null;
  }
  const optional = (key: string, name: keyof IdentityConfig) => {
    const value = text(env, key);
    return value ? { [name]: value } : {};
  };
  const fallbackOrgId = text(env, "VITE_FARSIDE_ORG");
  return {
    apiUrl,
    ...(fallbackOrgId ? { fallbackOrgId } : {}),
    config: {
      issuer,
      clientId,
      redirectUri:
        text(env, "VITE_FARSIDE_IDENTITY_REDIRECT_URI") ?? `${location.origin}${location.pathname}`,
      scope: text(env, "VITE_FARSIDE_IDENTITY_SCOPE") ?? DEFAULT_SCOPE,
      providerName: text(env, "VITE_FARSIDE_IDENTITY_NAME") ?? DEFAULT_PROVIDER,
      ...optional("VITE_FARSIDE_IDENTITY_AUDIENCE", "audience"),
      ...optional("VITE_FARSIDE_IDENTITY_ORG_CLAIM", "orgClaim"),
      ...optional("VITE_FARSIDE_IDENTITY_AUTHORIZE_URL", "authorizeUrl"),
      ...optional("VITE_FARSIDE_IDENTITY_TOKEN_URL", "tokenUrl"),
    } as IdentityConfig,
  };
}

const memory = new Map<string, string>();

/** sessionStorage, falling back to memory when the browser blocks it. */
export const browserStore: KeyValueStore = {
  get: (key) => {
    try {
      return window.sessionStorage.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set: (key, value) => {
    memory.set(key, value);
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      return;
    }
  },
  remove: (key) => {
    memory.delete(key);
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      return;
    }
  },
};

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Reads a JWT's payload without verifying it; the API verifies. Null for an opaque token. */
export function decodeClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
    );
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function claim(claims: Record<string, unknown> | null, name: string | undefined): unknown {
  if (!claims || !name) {
    return undefined;
  }
  if (name in claims) {
    return claims[name];
  }
  let current: unknown = claims;
  for (const segment of name.split(".")) {
    current =
      typeof current === "object" && current !== null
        ? (current as Record<string, unknown>)[segment]
        : undefined;
  }
  return current;
}

const firstString = (...values: unknown[]): string | null =>
  (values.find((value) => typeof value === "string" && value !== "") as string | undefined) ?? null;

export function sessionFromToken(
  runtime: Pick<IdentityRuntime, "config" | "fallbackOrgId">,
  token: string,
  expiresIn: number | undefined,
  now: number,
  idToken?: string,
): IdentitySession {
  const claims = decodeClaims(token);
  const profile = idToken ? decodeClaims(idToken) : null;
  const exp = claims?.exp;
  return {
    token,
    expiresAt:
      typeof exp === "number"
        ? exp * 1000
        : typeof expiresIn === "number"
          ? now + expiresIn * 1000
          : null,
    orgId: firstString(claim(claims, runtime.config.orgClaim), runtime.fallbackOrgId),
    name: firstString(
      profile?.name,
      profile?.email,
      claims?.name,
      claims?.email,
      profile?.sub,
      claims?.sub,
    ),
  };
}

export function loadSession(store: KeyValueStore, now: number): IdentitySession | null {
  const raw = store.get(SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    const session = JSON.parse(raw) as IdentitySession;
    if (
      typeof session.token !== "string" ||
      (session.expiresAt !== null && session.expiresAt <= now)
    ) {
      store.remove(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    store.remove(SESSION_KEY);
    return null;
  }
}

export function signOut(store: KeyValueStore): void {
  store.remove(SESSION_KEY);
  store.remove(PKCE_KEY);
}

type Endpoints = { authorize: string; token: string };

async function endpoints(config: IdentityConfig, call: typeof fetch): Promise<Endpoints> {
  if (config.authorizeUrl && config.tokenUrl) {
    return { authorize: config.authorizeUrl, token: config.tokenUrl };
  }
  let discovery: { authorization_endpoint?: unknown; token_endpoint?: unknown };
  try {
    const response = await call(
      `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    discovery = (await response.json()) as typeof discovery;
  } catch {
    throw new SignInError(`Could not reach ${config.providerName}. Try again shortly.`);
  }
  const authorize = config.authorizeUrl ?? discovery.authorization_endpoint;
  const token = config.tokenUrl ?? discovery.token_endpoint;
  if (typeof authorize !== "string" || typeof token !== "string") {
    throw new SignInError(`${config.providerName} did not publish its sign-in endpoints.`);
  }
  return { authorize, token };
}

const fetchOf = (runtime: IdentityRuntime): typeof fetch =>
  runtime.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

type Pending = { verifier: string; state: string; returnHash: string };

/** Sends the browser to the provider's authorize endpoint with a fresh PKCE verifier and state. */
export async function beginSignIn(runtime: IdentityRuntime, returnHash: string): Promise<void> {
  const store = runtime.storage ?? browserStore;
  const { authorize } = await endpoints(runtime.config, fetchOf(runtime));
  const pending: Pending = { verifier: randomToken(48), state: randomToken(), returnHash };
  store.set(PKCE_KEY, JSON.stringify(pending));
  const url = new URL(authorize);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: runtime.config.clientId,
    redirect_uri: runtime.config.redirectUri,
    scope: runtime.config.scope,
    state: pending.state,
    code_challenge: await pkceChallenge(pending.verifier),
    code_challenge_method: "S256",
    ...(runtime.config.audience ? { audience: runtime.config.audience } : {}),
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  (runtime.navigate ?? ((target: string) => window.location.assign(target)))(url.toString());
}

/** True when the current URL is the provider's redirect back to the console. */
export function isCallback(url: string): boolean {
  const params = new URL(url).searchParams;
  return params.has("state") && (params.has("code") || params.has("error"));
}

/** Exchanges the authorization code for a token, stores the session and returns the hash to reopen. */
export async function completeSignIn(
  runtime: IdentityRuntime,
  url: string,
): Promise<{ session: IdentitySession; returnHash: string }> {
  const store = runtime.storage ?? browserStore;
  const params = new URL(url).searchParams;
  const raw = store.get(PKCE_KEY);
  store.remove(PKCE_KEY);
  const pending = raw ? (JSON.parse(raw) as Pending) : null;
  if (!pending || params.get("state") !== pending.state) {
    throw new SignInError("The sign-in response did not match this browser tab. Sign in again.");
  }
  if (params.has("error")) {
    throw new SignInError(`${runtime.config.providerName} did not sign you in. Sign in again.`);
  }
  const { token: tokenUrl } = await endpoints(runtime.config, fetchOf(runtime));
  let body: { access_token?: unknown; id_token?: unknown; expires_in?: unknown };
  try {
    const response = await fetchOf(runtime)(tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.get("code") ?? "",
        redirect_uri: runtime.config.redirectUri,
        client_id: runtime.config.clientId,
        code_verifier: pending.verifier,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    body = (await response.json()) as typeof body;
  } catch {
    throw new SignInError(
      `${runtime.config.providerName} did not finish signing you in. Sign in again.`,
    );
  }
  const bearer = firstString(body.access_token, body.id_token);
  if (!bearer) {
    throw new SignInError(`${runtime.config.providerName} returned no token. Sign in again.`);
  }
  const session = sessionFromToken(
    runtime,
    bearer,
    typeof body.expires_in === "number" ? body.expires_in : undefined,
    (runtime.now ?? Date.now)(),
    typeof body.id_token === "string" ? body.id_token : undefined,
  );
  store.set(SESSION_KEY, JSON.stringify(session));
  return { session, returnHash: pending.returnHash };
}
