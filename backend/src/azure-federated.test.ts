import { describe, expect, it, vi } from "vitest";
import {
  ARM_SCOPE,
  CLIENT_ASSERTION_TYPE,
  ENTRA_ORIGIN,
  FederatedExchangeError,
  accessTokenClaims,
  assertionFileFromEnv,
  federatedTokenProvider,
  federatedTokenProviders,
  fileAssertionSource,
} from "./azure-federated.js";
import type { FetchLike } from "./azure-live.js";
import { FAKE_CLIENT_ID, FAKE_TENANT_ID, fakeAzure, fakeJwt } from "./azure-fake.js";
import { secretPaths } from "./secrets.js";

const ASSERTION = fakeJwt({ iss: "https://sts.amazonaws.com", sub: "farside-runtime", aud: "api://AzureADTokenExchange" });
const assertion = async () => ASSERTION;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function tokenFetch(lifetime = 3600) {
  let n = 0;
  return vi.fn<FetchLike>(async () => {
    n += 1;
    return json({ token_type: "Bearer", expires_in: lifetime, access_token: fakeJwt({ tid: FAKE_TENANT_ID, n }) });
  });
}

describe("federated credential exchange", () => {
  it("sends a client_credentials grant with the runtime assertion and no secret", async () => {
    const fetch = tokenFetch();
    const token = await federatedTokenProvider({ tenantId: FAKE_TENANT_ID, clientId: FAKE_CLIENT_ID, assertion, fetch })();
    expect(accessTokenClaims(token).tid).toBe(FAKE_TENANT_ID);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${ENTRA_ORIGIN}/${FAKE_TENANT_ID}/oauth2/v2.0/token`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toEqual({
      client_id: FAKE_CLIENT_ID,
      scope: ARM_SCOPE,
      grant_type: "client_credentials",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: ASSERTION,
    });
    expect([...form.keys()].some((key) => key.includes("secret"))).toBe(false);
  });

  it("caches until five minutes before expiry, then exchanges again", async () => {
    const fetch = tokenFetch(3600);
    let now = 0;
    const provider = federatedTokenProvider({ tenantId: FAKE_TENANT_ID, clientId: FAKE_CLIENT_ID, assertion, fetch, now: () => now });
    const first = await provider();
    now = 54 * 60_000;
    expect(await provider()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 55 * 60_000;
    expect(await provider()).not.toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes a short-lived token at half its life", async () => {
    const fetch = tokenFetch(60);
    let now = 0;
    const provider = federatedTokenProvider({ tenantId: FAKE_TENANT_ID, clientId: FAKE_CLIENT_ID, assertion, fetch, now: () => now });
    await provider();
    now = 29_000;
    await provider();
    now = 30_000;
    await provider();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one exchange between concurrent callers", async () => {
    const fetch = tokenFetch();
    const provider = federatedTokenProvider({ tenantId: FAKE_TENANT_ID, clientId: FAKE_CLIENT_ID, assertion, fetch });
    const tokens = await Promise.all([provider(), provider(), provider()]);
    expect(new Set(tokens).size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal by status and AADSTS code, never the assertion or a description", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      json({ error: "invalid_client", error_codes: [700213], error_description: `bad ${ASSERTION}` }, 401),
    );
    const provider = federatedTokenProvider({ tenantId: FAKE_TENANT_ID, clientId: FAKE_CLIENT_ID, assertion, fetch });
    const error = await provider().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FederatedExchangeError);
    expect((error as FederatedExchangeError).code).toBe("AADSTS700213");
    expect(String((error as Error).message)).not.toContain(ASSERTION);
    expect(secretPaths({ message: (error as Error).message })).toEqual([]);
    // A failed exchange is not cached.
    fetch.mockImplementation(async () => json({ token_type: "Bearer", expires_in: 3600, access_token: "a.b.c" }));
    expect(await provider()).toBe("a.b.c");
  });

  it("rejects a malformed token response instead of caching it", async () => {
    for (const body of [{ token_type: "Bearer", expires_in: 3600 }, { token_type: "pop", expires_in: 3600, access_token: "x" }, { token_type: "Bearer", expires_in: "soon", access_token: "x" }]) {
      const provider = federatedTokenProvider({
        tenantId: FAKE_TENANT_ID,
        clientId: FAKE_CLIENT_ID,
        assertion,
        fetch: async () => json(body),
      });
      await expect(provider()).rejects.toMatchObject({ code: "malformed_token_response" });
    }
  });

  it("refuses a bad tenant or client id before any call", () => {
    expect(() => federatedTokenProvider({ tenantId: "../evil", clientId: FAKE_CLIENT_ID, assertion })).toThrow(/tenant/);
    expect(() => federatedTokenProvider({ tenantId: FAKE_TENANT_ID, clientId: "farside", assertion })).toThrow(/client id/);
    expect(() => federatedTokenProvider({ tenantId: "contoso.onmicrosoft.com", clientId: FAKE_CLIENT_ID, assertion })).not.toThrow();
  });

  it("keeps one cached provider per tenant", async () => {
    const azure = fakeAzure({ now: () => new Date("2026-11-09T00:00:00Z") });
    const tokenFor = federatedTokenProviders({ clientId: FAKE_CLIENT_ID, assertion, fetch: azure.fetch });
    expect(tokenFor(FAKE_TENANT_ID)).toBe(tokenFor(FAKE_TENANT_ID.toUpperCase()));
    await tokenFor(FAKE_TENANT_ID)();
    await tokenFor(FAKE_TENANT_ID)();
    expect(azure.tokensIssued()).toBe(1);
  });
});

describe("assertion source", () => {
  it("re-reads the rotated file on every exchange and refuses a non-JWT", async () => {
    const contents = [`${ASSERTION}\n`, "not a token"];
    const read = vi.fn(async () => contents.shift() ?? "");
    const source = fileAssertionSource("/var/run/token", read);
    expect(await source()).toBe(ASSERTION);
    await expect(source()).rejects.toThrow("federated assertion file is not a JWT");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("prefers the Farside variable, then Azure's, then AWS's web identity file", () => {
    expect(assertionFileFromEnv({})).toBeNull();
    expect(assertionFileFromEnv({ AWS_WEB_IDENTITY_TOKEN_FILE: "/aws" })).toBe("/aws");
    expect(assertionFileFromEnv({ AWS_WEB_IDENTITY_TOKEN_FILE: "/aws", AZURE_FEDERATED_TOKEN_FILE: "/az" })).toBe("/az");
    expect(
      assertionFileFromEnv({ AWS_WEB_IDENTITY_TOKEN_FILE: "/aws", FARSIDE_AZURE_ASSERTION_FILE: "/farside" }),
    ).toBe("/farside");
  });

  it("reads only tid and oid from an access token, tolerating junk", () => {
    expect(accessTokenClaims(fakeJwt({ tid: "t", oid: "o", roles: ["x"] }))).toEqual({ tid: "t", oid: "o" });
    expect(accessTokenClaims("junk")).toEqual({ tid: null, oid: null });
    expect(accessTokenClaims("a.%%%.c")).toEqual({ tid: null, oid: null });
  });
});
