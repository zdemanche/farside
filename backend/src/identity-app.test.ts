import { Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { IdentityOptions } from "./identity.js";
import { secretPaths } from "./secrets.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";
import { testClaims, testIdentity, testSigner } from "./test-identity.js";

const NOW_S = 1_800_000_000;
const signer = testSigner("ES256");

function identityApp(overrides: Partial<IdentityOptions> = {}) {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, {
    ...TEST_APP_OPTIONS,
    logger: { level: "info", stream },
    identity: { ...testIdentity([signer]), now: () => NOW_S * 1000, ...overrides },
  });
  return { app, store, lines };
}

const bearer = (claims: Record<string, unknown> = {}) => ({
  authorization: `Bearer ${signer.sign(testClaims(NOW_S, claims))}`,
});

const ORG_ROUTES = [
  { method: "GET" as const, url: "/v1/orgs/org-a/settings" },
  { method: "PUT" as const, url: "/v1/orgs/org-a/settings" },
  { method: "GET" as const, url: "/v1/orgs/org-a/estate" },
  { method: "GET" as const, url: "/v1/orgs/org-a/inventory" },
  { method: "GET" as const, url: "/v1/orgs/org-a/issues" },
  { method: "PUT" as const, url: "/v1/orgs/org-a/connections" },
  { method: "POST" as const, url: "/v1/orgs/org-a/scans" },
  { method: "POST" as const, url: "/v1/orgs/org-a/offboard" },
  { method: "GET" as const, url: "/v1/orgs/org-a/claim" },
  { method: "POST" as const, url: "/v1/orgs/org-a/claim" },
];

describe("identity mode: bearer tokens replace the header session", () => {
  const { app } = identityApp();
  afterAll(() => app.close());

  it.each(ORG_ROUTES)("refuses the header stand-in on $method $url", async (route) => {
    const response = await app.inject({
      method: route.method,
      url: route.url,
      headers: { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ title: "Header session disabled", error: "header_session_disabled" });
    expect(response.headers["www-authenticate"]).toContain('error="invalid_token"');
  });

  it.each(ORG_ROUTES)("asks for a bearer token on $method $url", async (route) => {
    const response = await app.inject({ method: route.method, url: route.url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ title: "Unauthorized", error: "missing_token" });
    expect(response.headers["www-authenticate"]).toBe('Bearer realm="farside"');
  });

  it.each([
    ["expired", { exp: NOW_S - 10 }],
    ["wrong issuer", { iss: "https://other.invalid" }],
    ["wrong audience", { aud: "other" }],
    ["future nbf", { nbf: NOW_S + 600 }],
    ["missing org claim", { org: undefined }],
  ])("rejects a %s token with 401", async (_name, claims) => {
    const response = await app.inject({ method: "GET", url: "/v1/orgs/org-a/claim", headers: bearer(claims) });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "invalid_token" });
    expect(secretPaths(response.json())).toEqual([]);
  });

  it.each(ORG_ROUTES)("returns 403 on $method $url for another tenant's token", async (route) => {
    const response = await app.inject({
      method: route.method,
      url: route.url,
      headers: bearer({ org: "org-b", sub: "intruder" }),
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ title: "Forbidden" });
  });

  it("keeps /health open", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("org claim flow", () => {
  it("lets the first verified user claim the org, later users join, and repeats change nothing", async () => {
    const { app, lines } = identityApp();
    const cto = bearer({ sub: "cto" });
    const engineer = bearer({ sub: "engineer" });

    const before = await app.inject({ method: "GET", url: "/v1/orgs/org-a/claim", headers: cto });
    expect(before.json()).toEqual({
      orgId: "org-a",
      claimed: false,
      claimedAt: null,
      role: null,
      member: false,
      owner: false,
      memberCount: 0,
    });
    const blocked = await app.inject({ method: "GET", url: "/v1/orgs/org-a/settings", headers: cto });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: "org_not_claimed" });

    const claimed = await app.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers: cto });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json()).toMatchObject({ outcome: "claimed", role: "owner", owner: true, memberCount: 1 });

    const again = await app.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers: cto });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ outcome: "existing", role: "owner", memberCount: 1 });

    const notYet = await app.inject({ method: "GET", url: "/v1/orgs/org-a/settings", headers: engineer });
    expect(notYet.json()).toMatchObject({ error: "not_a_member" });

    const joined = await app.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers: engineer });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ outcome: "joined", role: "member", owner: false, memberCount: 2 });

    for (const headers of [cto, engineer]) {
      expect((await app.inject({ method: "GET", url: "/v1/orgs/org-a/settings", headers })).statusCode).toBe(200);
    }

    const audits = lines.filter((line) => line.event === "org.claim");
    expect(audits.map((line) => [line.actorId, line.outcome])).toEqual([
      ["cto", "claimed"],
      ["cto", "existing"],
      ["engineer", "joined"],
    ]);
    expect(audits.every((line) => line.orgId === "org-a")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(cto.authorization.slice(7));
    await app.close();
  });

  it("keeps two tenants' claims apart", async () => {
    const { app } = identityApp();
    await app.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers: bearer({ sub: "a-cto" }) });
    const other = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-b/claim",
      headers: bearer({ org: "org-b", sub: "b-cto" }),
    });
    expect(other.statusCode).toBe(201);
    expect(other.json()).toMatchObject({ orgId: "org-b", role: "owner", memberCount: 1 });
    const cross = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/claim",
      headers: bearer({ org: "org-b", sub: "b-cto" }),
    });
    expect(cross.statusCode).toBe(403);
    const view = await app.inject({ method: "GET", url: "/v1/orgs/org-a/claim", headers: bearer({ sub: "a-cto" }) });
    expect(view.json()).toMatchObject({ role: "owner", memberCount: 1 });
    await app.close();
  });

  it("lets only the configured claim role own an unclaimed org; others may join after", async () => {
    const { app } = identityApp({ claimRole: "farside-owner" });
    const refused = await app.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers: bearer({ sub: "dev" }) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "claim_role_required" });
    const owner = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/claim",
      headers: bearer({ sub: "cto", roles: ["farside-owner"] }),
    });
    expect(owner.statusCode).toBe(201);
    const joined = await app.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers: bearer({ sub: "dev" }) });
    expect(joined.json()).toMatchObject({ outcome: "joined", role: "member" });
    await app.close();
  });

  it("records the token's actor on offboard and still answers the deletion record afterwards", async () => {
    const { app } = identityApp();
    const cto = bearer({ sub: "cto" });
    await app.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers: cto });
    const offboard = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/offboard",
      headers: cto,
      payload: { confirm: true, exportOffered: true },
    });
    expect(offboard.statusCode).toBe(200);
    const deletion = await app.inject({ method: "GET", url: "/v1/orgs/org-a/deletion", headers: cto });
    expect(deletion.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/orgs/org-a/settings", headers: cto })).statusCode).toBe(410);
    await app.close();
  });
});

describe("header mode (identity not configured)", () => {
  const app = buildApp(new MemoryStore(fixedClock), TEST_APP_OPTIONS);
  afterAll(() => app.close());
  const headers = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

  it("keeps reading without a claim, as before", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/orgs/org-a/settings", headers })).statusCode).toBe(200);
  });

  it("ignores bearer tokens and still needs the header", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/orgs/org-a/settings", headers: bearer() });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });

  it("serves the claim API with the header session", async () => {
    const claimed = await app.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json()).toMatchObject({ role: "owner" });
  });
});
