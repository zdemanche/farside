import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import type { FetchLike, IdentityAlgorithm, IdentityOptions } from "./identity.js";

/** A locally generated signing key and a JWKS for tests. Never a real Identity key. */
export type TestSigner = {
  alg: IdentityAlgorithm;
  kid: string;
  jwk: JsonWebKey;
  sign: (payload: Record<string, unknown>, header?: Record<string, unknown>) => string;
};

export const TEST_ISSUER = "https://identity.test.invalid";
export const TEST_AUDIENCE = "farside-api";
export const TEST_JWKS_URL = `${TEST_ISSUER}/jwks`;
export const TEST_ORG_CLAIM = "org";
export const TEST_ROLE_CLAIM = "roles";

export function testSigner(alg: IdentityAlgorithm = "RS256", kid = `test-${alg.toLowerCase()}`): TestSigner {
  const { privateKey, publicKey } =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return signerFrom(alg, kid, privateKey, publicKey);
}

function signerFrom(alg: IdentityAlgorithm, kid: string, privateKey: KeyObject, publicKey: KeyObject): TestSigner {
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg, use: "sig" };
  return {
    alg,
    kid,
    jwk,
    sign: (payload, header = {}) => {
      const head = Buffer.from(JSON.stringify({ alg, typ: "JWT", kid, ...header })).toString("base64url");
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const input = Buffer.from(`${head}.${body}`);
      const signature =
        alg === "RS256"
          ? sign("sha256", input, privateKey)
          : sign("sha256", input, { key: privateKey, dsaEncoding: "ieee-p1363" });
      return `${head}.${body}.${signature.toString("base64url")}`;
    },
  };
}

/** Standard claims for a token valid at `nowSeconds`; override any of them. */
export function testClaims(
  nowSeconds: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    sub: "user-1",
    [TEST_ORG_CLAIM]: "org-a",
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 300,
    ...overrides,
  };
}

/** A fetch that serves the signers' JWKS and counts calls. */
export function jwksFetch(signers: () => readonly TestSigner[]): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    if (url === TEST_JWKS_URL) {
      return { ok: true, status: 200, json: async () => ({ keys: signers().map((signer) => signer.jwk) }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return Object.assign(impl, { calls });
}

export function testIdentity(
  signers: readonly TestSigner[],
  overrides: Partial<IdentityOptions> = {},
): IdentityOptions & { fetch: FetchLike & { calls: string[] } } {
  const fetch = jwksFetch(() => signers);
  return {
    issuer: TEST_ISSUER,
    audiences: [TEST_AUDIENCE],
    jwksUrl: TEST_JWKS_URL,
    orgClaim: TEST_ORG_CLAIM,
    actorClaim: "sub",
    roleClaim: TEST_ROLE_CLAIM,
    algorithms: ["RS256", "ES256"],
    clockToleranceSeconds: 0,
    jwksCacheSeconds: 600,
    ...overrides,
    fetch,
  };
}
