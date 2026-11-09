import { describe, expect, it, vi } from "vitest";
import { apiSource, claimApi } from "./api";
import {
  beginSignIn,
  completeSignIn,
  decodeClaims,
  identityFromEnv,
  isCallback,
  loadSession,
  pkceChallenge,
  PKCE_KEY,
  SESSION_KEY,
  sessionFromToken,
  type IdentityRuntime,
} from "./identity";
import { fakeJwt, memoryStore } from "../test-utils";

const LOCATION = { origin: "https://console.test", pathname: "/" };
const ENV = {
  VITE_FARSIDE_API_URL: "https://api.test",
  VITE_FARSIDE_IDENTITY_ISSUER: "https://idp.test",
  VITE_FARSIDE_IDENTITY_CLIENT_ID: "farside-console",
  VITE_FARSIDE_IDENTITY_ORG_CLAIM: "org",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DISCOVERY = {
  authorization_endpoint: "https://idp.test/authorize",
  token_endpoint: "https://idp.test/token",
};

describe("identity config", () => {
  it("is off unless issuer, client id and API URL are all set", () => {
    expect(identityFromEnv({}, LOCATION)).toBeNull();
    expect(identityFromEnv({ ...ENV, VITE_FARSIDE_API_URL: "" }, LOCATION)).toBeNull();
    expect(identityFromEnv({ ...ENV, VITE_FARSIDE_IDENTITY_CLIENT_ID: " " }, LOCATION)).toBeNull();
  });

  it("stays off in demo mode", () => {
    expect(identityFromEnv({ ...ENV, VITE_FARSIDE_DEMO: "1" }, LOCATION)).toBeNull();
  });

  it("reads the env with standard defaults", () => {
    expect(identityFromEnv({ ...ENV, VITE_FARSIDE_ORG: "fallback" }, LOCATION)).toEqual({
      apiUrl: "https://api.test",
      fallbackOrgId: "fallback",
      config: {
        issuer: "https://idp.test",
        clientId: "farside-console",
        redirectUri: "https://console.test/",
        scope: "openid profile email",
        providerName: "Moonaan Identity",
        orgClaim: "org",
      },
    });
  });
});

describe("PKCE sign-in", () => {
  it("derives the RFC 7636 S256 challenge", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("redirects to the discovered authorize endpoint with code + S256 challenge and state", async () => {
    const storage = memoryStore();
    const navigate = vi.fn();
    const fetch = vi.fn(async () => json(DISCOVERY));
    const runtime = { ...identityFromEnv(ENV, LOCATION)!, storage, navigate, fetch };
    await beginSignIn(runtime, "#issues");
    expect(fetch).toHaveBeenCalledWith(
      "https://idp.test/.well-known/openid-configuration",
      expect.anything(),
    );
    const url = new URL(navigate.mock.calls[0]?.[0] as string);
    const pending = JSON.parse(storage.data.get(PKCE_KEY) ?? "{}") as Record<string, string>;
    expect(url.origin + url.pathname).toBe("https://idp.test/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "farside-console",
      redirect_uri: "https://console.test/",
      scope: "openid profile email",
      state: pending.state,
      code_challenge: await pkceChallenge(pending.verifier ?? ""),
      code_challenge_method: "S256",
    });
    expect(pending.returnHash).toBe("#issues");
  });

  it("skips discovery when both endpoints are configured", async () => {
    const fetch = vi.fn();
    const navigate = vi.fn();
    const runtime = {
      ...identityFromEnv(
        {
          ...ENV,
          VITE_FARSIDE_IDENTITY_AUTHORIZE_URL: "https://idp.test/a",
          VITE_FARSIDE_IDENTITY_TOKEN_URL: "https://idp.test/t",
          VITE_FARSIDE_IDENTITY_AUDIENCE: "farside-api",
        },
        LOCATION,
      )!,
      storage: memoryStore(),
      navigate,
      fetch,
    };
    await beginSignIn(runtime, "");
    expect(fetch).not.toHaveBeenCalled();
    expect(new URL(navigate.mock.calls[0]?.[0] as string).searchParams.get("audience")).toBe(
      "farside-api",
    );
  });

  it("explains when the provider cannot be reached", async () => {
    const runtime = {
      ...identityFromEnv(ENV, LOCATION)!,
      storage: memoryStore(),
      navigate: vi.fn(),
      fetch: vi.fn(async () => json({}, 503)),
    };
    await expect(beginSignIn(runtime, "")).rejects.toThrow("Could not reach Moonaan Identity");
  });

  it("exchanges the code with the verifier and stores the session", async () => {
    const storage = memoryStore();
    storage.set(PKCE_KEY, JSON.stringify({ verifier: "v", state: "s", returnHash: "#scans" }));
    const token = fakeJwt({
      sub: "u1",
      org: "org-a",
      exp: 2_000_000_000,
      email: "cto@example.test",
    });
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url).endsWith("/token")
        ? (expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
            grant_type: "authorization_code",
            code: "c",
            redirect_uri: "https://console.test/",
            client_id: "farside-console",
            code_verifier: "v",
          }),
          json({ access_token: token, token_type: "Bearer", expires_in: 300 }))
        : json(DISCOVERY),
    );
    const runtime: IdentityRuntime = { ...identityFromEnv(ENV, LOCATION)!, storage, fetch };
    const { session, returnHash } = await completeSignIn(
      runtime,
      "https://console.test/?code=c&state=s",
    );
    expect(returnHash).toBe("#scans");
    expect(session).toEqual({
      token,
      expiresAt: 2_000_000_000_000,
      orgId: "org-a",
      name: "cto@example.test",
    });
    expect(JSON.parse(storage.data.get(SESSION_KEY) ?? "{}")).toEqual(session);
    expect(storage.data.has(PKCE_KEY)).toBe(false);
  });

  it.each([
    ["a mismatched state", "https://console.test/?code=c&state=other", "did not match"],
    [
      "a provider error",
      "https://console.test/?error=access_denied&state=s",
      "did not sign you in",
    ],
  ])("refuses %s", async (_name, url, message) => {
    const storage = memoryStore();
    storage.set(PKCE_KEY, JSON.stringify({ verifier: "v", state: "s", returnHash: "" }));
    const runtime = { ...identityFromEnv(ENV, LOCATION)!, storage, fetch: vi.fn() };
    await expect(completeSignIn(runtime, url)).rejects.toThrow(message);
    expect(storage.data.has(SESSION_KEY)).toBe(false);
  });

  it("recognises the redirect back", () => {
    expect(isCallback("https://console.test/?code=c&state=s#x")).toBe(true);
    expect(isCallback("https://console.test/?error=e&state=s")).toBe(true);
    expect(isCallback("https://console.test/?code=c")).toBe(false);
    expect(isCallback("https://console.test/#estate")).toBe(false);
  });
});

describe("stored session", () => {
  it("drops an expired token", () => {
    const storage = memoryStore();
    storage.set(
      SESSION_KEY,
      JSON.stringify({ token: "t", expiresAt: 1000, orgId: "o", name: null }),
    );
    expect(loadSession(storage, 999)?.token).toBe("t");
    expect(loadSession(storage, 1000)).toBeNull();
    expect(storage.data.has(SESSION_KEY)).toBe(false);
  });

  it("drops an unreadable entry", () => {
    const storage = memoryStore();
    storage.set(SESSION_KEY, "{");
    expect(loadSession(storage, 0)).toBeNull();
  });

  it("falls back to VITE_FARSIDE_ORG when the token has no org claim, and to expires_in", () => {
    const runtime = { ...identityFromEnv({ ...ENV, VITE_FARSIDE_ORG: "org-z" }, LOCATION)! };
    expect(sessionFromToken(runtime, fakeJwt({ sub: "u" }), 60, 1000)).toMatchObject({
      orgId: "org-z",
      expiresAt: 61_000,
      name: "u",
    });
    expect(sessionFromToken(runtime, "opaque", undefined, 0)).toMatchObject({
      orgId: "org-z",
      expiresAt: null,
    });
  });

  it("decodes base64url payloads and ignores opaque tokens", () => {
    expect(decodeClaims(fakeJwt({ sub: "u" }))).toMatchObject({ sub: "u" });
    expect(decodeClaims("nope")).toBeNull();
  });
});

describe("bearer on API calls", () => {
  it("sends the token instead of the org header", async () => {
    const fetch = vi.fn(async () => json({ ownerTagKey: "owner" }));
    await apiSource({
      baseUrl: "https://api.test/",
      orgId: "org-a",
      token: "tok",
      fetch,
    }).settings();
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(init.headers).not.toHaveProperty("x-farside-org");
  });

  it("keeps the org header without a token", async () => {
    const fetch = vi.fn(async () => json({ ownerTagKey: "owner" }));
    await apiSource({ baseUrl: "https://api.test", orgId: "org-a", fetch }).settings();
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ "x-farside-org": "org-a" });
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("calls the claim API and surfaces the problem's error code", async () => {
    const fetch = vi.fn(async () =>
      json({ title: "Claim needs the owner role", error: "claim_role_required" }, 403),
    );
    const api = claimApi({ baseUrl: "https://api.test", orgId: "org-a", token: "tok", fetch });
    await expect(api.claim()).rejects.toMatchObject({
      kind: "denied",
      code: "claim_role_required",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/v1/orgs/org-a/claim",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
