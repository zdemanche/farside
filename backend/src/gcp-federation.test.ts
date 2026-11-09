import { describe, expect, it, vi } from "vitest";
import {
  GcpFederationError,
  IAM_CREDENTIALS_ORIGIN,
  JWT_TOKEN_TYPE,
  READ_ONLY_SCOPE,
  STS_TOKEN_URL,
  federationAudience,
  fileSubjectToken,
  gcpFederatedTokenProvider,
  impersonationUrl,
  type FetchLike,
} from "./gcp-federation.js";
import { SecretLeakError, assertNoSecrets } from "./secrets.js";

const SA = "farside-reader@farside-test.iam.gserviceaccount.com";
const ACCESS = "ya29.impersonated-access-token-value-0001";
const base = {
  poolProjectNumber: "123456789",
  poolId: "farside-pool",
  providerId: "farside-aws",
  serviceAccount: SA,
  subjectToken: async () => "eyJhbGciOiJSUzI1NiJ9.oidc-subject.sig",
};

function exchangeFetch(expireTime = "2026-12-01T10:00:00Z") {
  return vi.fn<FetchLike>(async (url) => {
    if (url === STS_TOKEN_URL) {
      return Response.json({
        access_token: "federated-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return Response.json({ accessToken: ACCESS, expireTime });
  });
}

function bodyOf(fetch: ReturnType<typeof exchangeFetch>, call: number) {
  return JSON.parse(String(fetch.mock.calls[call]?.[1]?.body));
}

describe("GCP workload identity federation", () => {
  it("exchanges the OIDC token at STS, then impersonates the service account", async () => {
    const fetch = exchangeFetch();
    const token = gcpFederatedTokenProvider({
      ...base,
      fetch,
      now: () => new Date("2026-12-01T09:00:00Z"),
    });
    expect(await token()).toBe(ACCESS);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([STS_TOKEN_URL, impersonationUrl(SA)]);
    expect(bodyOf(fetch, 0)).toEqual({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience:
        "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/farside-pool/providers/farside-aws",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectToken: "eyJhbGciOiJSUzI1NiJ9.oidc-subject.sig",
      subjectTokenType: JWT_TOKEN_TYPE,
    });
    expect(
      String(fetch.mock.calls[1]?.[0]).startsWith(
        `${IAM_CREDENTIALS_ORIGIN}/v1/projects/-/serviceAccounts/`,
      ),
    ).toBe(true);
    expect((fetch.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization).toBe(
      "Bearer federated-token",
    );
    expect(bodyOf(fetch, 1)).toEqual({ scope: [READ_ONLY_SCOPE], lifetime: "3600s" });
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("caches until five minutes before expiry and shares one exchange between callers", async () => {
    const fetch = exchangeFetch("2026-12-01T10:00:00Z");
    let now = new Date("2026-12-01T09:00:00Z");
    const token = gcpFederatedTokenProvider({ ...base, fetch, now: () => now });
    await Promise.all([token(), token(), token()]);
    expect(fetch).toHaveBeenCalledTimes(2);
    now = new Date("2026-12-01T09:54:00Z");
    await token();
    expect(fetch).toHaveBeenCalledTimes(2);
    now = new Date("2026-12-01T09:56:00Z");
    await token();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("reports the failing step and status, never the token or response body", async () => {
    const fetch = vi.fn<FetchLike>(
      async () => new Response(`{"error":"invalid_grant","detail":"${ACCESS}"}`, { status: 400 }),
    );
    const token = gcpFederatedTokenProvider({ ...base, fetch });
    const error = await token().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GcpFederationError);
    expect(error).toMatchObject({ step: "sts", status: 400 });
    expect(String((error as Error).message)).not.toContain("ya29");
  });

  it("fails the impersonation step on a refused grant and retries afterwards", async () => {
    let refuse = true;
    const fetch = vi.fn<FetchLike>(async (url) => {
      if (url === STS_TOKEN_URL) {
        return Response.json({ access_token: "federated-token" });
      }
      return refuse
        ? Response.json({}, { status: 403 })
        : Response.json({ accessToken: ACCESS, expireTime: "2026-12-01T10:00:00Z" });
    });
    const token = gcpFederatedTokenProvider({
      ...base,
      fetch,
      now: () => new Date("2026-12-01T09:00:00Z"),
    });
    await expect(token()).rejects.toMatchObject({ step: "impersonation", status: 403 });
    refuse = false;
    expect(await token()).toBe(ACCESS);
  });

  it("hides network error detail", async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new Error(`connect failed with ${ACCESS}`);
    });
    const error = await gcpFederatedTokenProvider({ ...base, fetch })().catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ step: "sts", status: null });
    expect(String((error as Error).message)).not.toContain("ya29");
  });

  it("rejects malformed pool, provider and service account before any call", () => {
    expect(() =>
      federationAudience({
        poolProjectNumber: "abc",
        poolId: "farside-pool",
        providerId: "farside-aws",
      }),
    ).toThrow();
    expect(() =>
      federationAudience({ poolProjectNumber: "1", poolId: "../x", providerId: "farside-aws" }),
    ).toThrow();
    expect(() => impersonationUrl("someone@example.com")).toThrow();
    expect(() => gcpFederatedTokenProvider({ ...base, lifetimeSeconds: 7200 })).toThrow();
  });

  it("reads the subject token file on each exchange and treats a missing file as a subject-token failure", async () => {
    const read = vi.fn(async () => " oidc \n");
    expect(await fileSubjectToken("/var/run/token", read)()).toBe("oidc");
    const missing = fileSubjectToken("/nope", async () => {
      throw new Error("ENOENT");
    });
    await expect(missing()).rejects.toMatchObject({ step: "subject_token" });
    await expect(fileSubjectToken("/empty", async () => "")()).rejects.toMatchObject({
      step: "subject_token",
    });
  });

  it("produces tokens that assertNoSecrets would catch if they ever reached storage", () => {
    expect(() => assertNoSecrets({ note: `Bearer ${ACCESS}` })).toThrow(SecretLeakError);
  });
});
