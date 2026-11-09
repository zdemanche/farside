import { describe, expect, it } from "vitest";
import {
  claimValue,
  createAuthenticator,
  createVerifier,
  identityConfigFromEnv,
  sessionFromClaims,
  TokenError,
  type FetchLike,
} from "./identity.js";
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_JWKS_URL,
  testClaims,
  testIdentity,
  testSigner,
} from "./test-identity.js";

const NOW_S = 1_800_000_000;
const now = () => NOW_S * 1000;
const rsa = testSigner("RS256");
const ec = testSigner("ES256");

describe("bearer token verification", () => {
  it.each([rsa, ec])("accepts a $alg token signed by a JWKS key", async (signer) => {
    const verify = createVerifier({ ...testIdentity([rsa, ec]), now });
    const { payload } = await verify(signer.sign(testClaims(NOW_S)));
    expect(payload.sub).toBe("user-1");
  });

  it.each([
    ["a wrong issuer", { iss: "https://elsewhere.invalid" }, "unexpected issuer"],
    ["a wrong audience", { aud: "someone-else" }, "unexpected audience"],
    ["an expired token", { exp: NOW_S - 1 }, "token expired"],
    ["a token with no exp", { exp: undefined }, "token expired"],
    ["a token that is not yet valid", { nbf: NOW_S + 120 }, "token not yet valid"],
  ])("rejects %s", async (_name, overrides, message) => {
    const verify = createVerifier({ ...testIdentity([rsa]), now });
    await expect(verify(rsa.sign(testClaims(NOW_S, overrides)))).rejects.toThrow(message);
  });

  it("accepts an audience list that contains a configured audience", async () => {
    const verify = createVerifier({ ...testIdentity([rsa]), now });
    await expect(verify(rsa.sign(testClaims(NOW_S, { aud: ["x", TEST_AUDIENCE] })))).resolves.toBeTruthy();
  });

  it("allows the configured clock tolerance around exp and nbf", async () => {
    const verify = createVerifier({ ...testIdentity([rsa], { clockToleranceSeconds: 60 }), now });
    await expect(
      verify(rsa.sign(testClaims(NOW_S, { exp: NOW_S - 30, nbf: NOW_S + 30 }))),
    ).resolves.toBeTruthy();
  });

  it("rejects a token signed by a key that is not in the JWKS", async () => {
    const stranger = testSigner("RS256", rsa.kid);
    const verify = createVerifier({ ...testIdentity([rsa]), now });
    await expect(verify(stranger.sign(testClaims(NOW_S)))).rejects.toThrow("bad signature");
  });

  it("rejects a tampered payload", async () => {
    const verify = createVerifier({ ...testIdentity([rsa]), now });
    const [head, , sig] = rsa.sign(testClaims(NOW_S)).split(".");
    const forged = Buffer.from(JSON.stringify(testClaims(NOW_S, { org: "org-b" }))).toString("base64url");
    await expect(verify(`${head}.${forged}.${sig}`)).rejects.toThrow("bad signature");
  });

  it.each(["none", "HS256", "RS512"])("rejects alg %s", async (alg) => {
    const verify = createVerifier({ ...testIdentity([rsa]), now });
    await expect(verify(rsa.sign(testClaims(NOW_S), { alg }))).rejects.toThrow("is not accepted");
  });

  it("rejects an RS256 header pointing at an EC key", async () => {
    const verify = createVerifier({ ...testIdentity([ec]), now });
    await expect(verify(ec.sign(testClaims(NOW_S), { alg: "RS256" }))).rejects.toThrow(
      "no matching signing key",
    );
  });

  it.each(["", "a.b", "a.b.c.d", "!!.!!.!!"])("rejects the malformed token %j", async (token) => {
    const verify = createVerifier({ ...testIdentity([rsa]), now });
    await expect(verify(token)).rejects.toBeInstanceOf(TokenError);
  });

  it("checks azp against the client id when the token carries one", async () => {
    const verify = createVerifier({ ...testIdentity([rsa], { clientId: "console" }), now });
    await expect(verify(rsa.sign(testClaims(NOW_S, { azp: "console" })))).resolves.toBeTruthy();
    await expect(verify(rsa.sign(testClaims(NOW_S, { azp: "other" })))).rejects.toThrow("authorized party");
  });
});

describe("JWKS cache", () => {
  it("fetches the key set once and reuses it", async () => {
    const identity = testIdentity([rsa]);
    const verify = createVerifier({ ...identity, now });
    await verify(rsa.sign(testClaims(NOW_S)));
    await verify(rsa.sign(testClaims(NOW_S, { sub: "user-2" })));
    expect(identity.fetch.calls).toEqual([TEST_JWKS_URL]);
  });

  it("refetches for an unknown kid so a rotated key is picked up", async () => {
    let clock = NOW_S * 1000;
    const keys = [rsa];
    const identity = testIdentity(keys);
    const verify = createVerifier({ ...identity, now: () => clock });
    await verify(rsa.sign(testClaims(NOW_S)));
    const rotated = testSigner("ES256", "rotated");
    keys.push(rotated);
    clock += 31_000;
    await expect(verify(rotated.sign(testClaims(NOW_S)))).resolves.toBeTruthy();
    expect(identity.fetch.calls).toHaveLength(2);
  });

  it("does not refetch more than once per 30 seconds for unknown kids", async () => {
    const identity = testIdentity([rsa]);
    const verify = createVerifier({ ...identity, now });
    await verify(rsa.sign(testClaims(NOW_S)));
    const unknown = testSigner("RS256", "unknown");
    await expect(verify(unknown.sign(testClaims(NOW_S)))).rejects.toThrow("no matching signing key");
    await expect(verify(unknown.sign(testClaims(NOW_S)))).rejects.toThrow("no matching signing key");
    expect(identity.fetch.calls).toHaveLength(1);
  });

  it("expires the cache after the configured time", async () => {
    let clock = NOW_S * 1000;
    const identity = testIdentity([rsa], { jwksCacheSeconds: 60 });
    const verify = createVerifier({ ...identity, now: () => clock });
    await verify(rsa.sign(testClaims(NOW_S)));
    clock += 61_000;
    await verify(rsa.sign(testClaims(NOW_S + 61)));
    expect(identity.fetch.calls).toHaveLength(2);
  });

  it("discovers jwks_uri from the issuer when no JWKS URL is configured", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      if (url === `${TEST_ISSUER}/.well-known/openid-configuration`) {
        return { ok: true, status: 200, json: async () => ({ issuer: TEST_ISSUER, jwks_uri: TEST_JWKS_URL }) };
      }
      return { ok: true, status: 200, json: async () => ({ keys: [rsa.jwk] }) };
    };
    const verify = createVerifier({ ...testIdentity([rsa]), jwksUrl: undefined, fetch, now });
    await expect(verify(rsa.sign(testClaims(NOW_S)))).resolves.toBeTruthy();
    expect(calls).toEqual([`${TEST_ISSUER}/.well-known/openid-configuration`, TEST_JWKS_URL]);
  });

  it("fails closed when the JWKS cannot be fetched", async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const verify = createVerifier({ ...testIdentity([rsa]), fetch, now });
    await expect(verify(rsa.sign(testClaims(NOW_S)))).rejects.toThrow("503");
  });
});

describe("claims to session", () => {
  const config = testIdentity([rsa]);

  it("maps the configured org, actor and role claims", () => {
    expect(sessionFromClaims(config, testClaims(NOW_S, { roles: ["owner", "x"] }))).toEqual({
      orgId: "org-a",
      actorId: "user-1",
      roles: ["owner", "x"],
      via: "token",
    });
  });

  it("reads URL-style and nested claim names", () => {
    expect(claimValue({ "https://example.test/org": "o" }, "https://example.test/org")).toBe("o");
    expect(claimValue({ tenant: { id: "t" } }, "tenant.id")).toBe("t");
    expect(claimValue({ tenant: "t" }, "tenant.id")).toBeUndefined();
  });

  it("splits a space-separated role string", () => {
    expect(sessionFromClaims(config, testClaims(NOW_S, { roles: "owner reader" }))?.roles).toEqual([
      "owner",
      "reader",
    ]);
  });

  it.each([
    ["a missing org claim", { org: undefined }],
    ["an org id that could escape the storage prefix", { org: "../x" }],
    ["a missing actor", { sub: "" }],
  ])("returns null for %s", (_name, overrides) => {
    expect(sessionFromClaims(config, testClaims(NOW_S, overrides))).toBeNull();
  });
});

describe("authenticator", () => {
  const authenticate = createAuthenticator({ ...testIdentity([rsa]), now });

  it("refuses the header stand-in even with a valid token", async () => {
    expect(
      await authenticate({ authorization: `Bearer ${rsa.sign(testClaims(NOW_S))}`, "x-farside-org": "org-a" }),
    ).toEqual({ error: "header_session_disabled" });
    expect(await authenticate({ "x-farside-actor": "a" })).toEqual({ error: "header_session_disabled" });
  });

  it("asks for a token when none is sent", async () => {
    expect(await authenticate({})).toEqual({ error: "missing_token" });
    expect(await authenticate({ authorization: "Basic abc" })).toEqual({ error: "missing_token" });
  });

  it("returns the session for a valid bearer token", async () => {
    expect(await authenticate({ authorization: `bearer ${rsa.sign(testClaims(NOW_S))}` })).toMatchObject({
      session: { orgId: "org-a", actorId: "user-1" },
    });
  });

  it("explains an invalid token without throwing", async () => {
    expect(
      await authenticate({ authorization: `Bearer ${rsa.sign(testClaims(NOW_S, { org: undefined }))}` }),
    ).toEqual({ error: "invalid_token", detail: "missing org or actor claim" });
  });
});

describe("identity config from env", () => {
  it("is off without an issuer, so the header session stays", () => {
    expect(identityConfigFromEnv({})).toBeUndefined();
  });

  it("reads every setting", () => {
    expect(
      identityConfigFromEnv({
        FARSIDE_IDENTITY_ISSUER: TEST_ISSUER,
        FARSIDE_IDENTITY_AUDIENCE: "a, b",
        FARSIDE_IDENTITY_JWKS_URL: TEST_JWKS_URL,
        FARSIDE_IDENTITY_CLIENT_ID: "console",
        FARSIDE_IDENTITY_ORG_CLAIM: "org",
        FARSIDE_IDENTITY_ACTOR_CLAIM: "email",
        FARSIDE_IDENTITY_ROLE_CLAIM: "roles",
        FARSIDE_IDENTITY_CLAIM_ROLE: "owner",
        FARSIDE_IDENTITY_ALGORITHMS: "ES256",
        FARSIDE_IDENTITY_CLOCK_TOLERANCE_SECONDS: "5",
        FARSIDE_IDENTITY_JWKS_CACHE_SECONDS: "30",
      }),
    ).toEqual({
      issuer: TEST_ISSUER,
      audiences: ["a", "b"],
      jwksUrl: TEST_JWKS_URL,
      clientId: "console",
      orgClaim: "org",
      actorClaim: "email",
      roleClaim: "roles",
      claimRole: "owner",
      algorithms: ["ES256"],
      clockToleranceSeconds: 5,
      jwksCacheSeconds: 30,
    });
  });

  it.each([
    [{ FARSIDE_IDENTITY_ORG_CLAIM: "org" }, "FARSIDE_IDENTITY_AUDIENCE"],
    [{ FARSIDE_IDENTITY_AUDIENCE: "a" }, "FARSIDE_IDENTITY_ORG_CLAIM"],
    [{ FARSIDE_IDENTITY_AUDIENCE: "a", FARSIDE_IDENTITY_ORG_CLAIM: "o", FARSIDE_IDENTITY_ALGORITHMS: "HS256" }, "unsupported"],
    [
      { FARSIDE_IDENTITY_AUDIENCE: "a", FARSIDE_IDENTITY_ORG_CLAIM: "o", FARSIDE_IDENTITY_CLOCK_TOLERANCE_SECONDS: "x" },
      "whole number",
    ],
  ])("refuses to start half-configured (%j)", (env, message) => {
    expect(() => identityConfigFromEnv({ FARSIDE_IDENTITY_ISSUER: TEST_ISSUER, ...env })).toThrow(message);
  });
});
