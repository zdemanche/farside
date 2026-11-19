import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { IdentityConfig } from "./identity.js";
import {
  assertIdentityPolicy,
  IdentityRequiredError,
  OWNER_ONLY_ENV,
  REQUIRE_IDENTITY_ENV,
} from "./identity-policy.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";
import { testClaims, testIdentity, testSigner } from "./test-identity.js";

const IDENTITY = { issuer: "https://issuer.example" } as unknown as IdentityConfig;

describe("assertIdentityPolicy", () => {
  it("does nothing when Identity is configured", () => {
    const warn = vi.fn();
    expect(() =>
      assertIdentityPolicy({ [REQUIRE_IDENTITY_ENV]: "1", NODE_ENV: "production" }, IDENTITY, warn),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses to start without Identity when it is required", () => {
    expect(() => assertIdentityPolicy({ [REQUIRE_IDENTITY_ENV]: "1" }, undefined)).toThrow(
      IdentityRequiredError,
    );
  });

  it("only warns in production without Identity, and starts", () => {
    const warn = vi.fn();
    expect(() => assertIdentityPolicy({ NODE_ENV: "production" }, undefined, warn)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("FARSIDE_IDENTITY_ISSUER");
  });

  it("warns that owner-only cannot hold without Identity, and still starts", () => {
    const warn = vi.fn();
    expect(() => assertIdentityPolicy({ [OWNER_ONLY_ENV]: "1" }, undefined, warn)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(OWNER_ONLY_ENV);
  });

  it("does not warn about owner-only when Identity is configured", () => {
    const warn = vi.fn();
    assertIdentityPolicy({ [OWNER_ONLY_ENV]: "1" }, IDENTITY, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent in development and when the flag is anything but 1", () => {
    const warn = vi.fn();
    expect(() => assertIdentityPolicy({}, undefined, warn)).not.toThrow();
    expect(() =>
      assertIdentityPolicy({ [REQUIRE_IDENTITY_ENV]: "true" }, undefined, warn),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("owner-only destructive actions", () => {
  const NOW_S = 1_800_000_000;
  const signer = testSigner("ES256");
  const apps: Array<ReturnType<typeof buildApp>> = [];

  function app() {
    const built = buildApp(new MemoryStore(fixedClock), {
      ...TEST_APP_OPTIONS,
      identity: { ...testIdentity([signer]), now: () => NOW_S * 1000 },
    });
    apps.push(built);
    return built;
  }

  const as = (sub: string) => ({
    authorization: `Bearer ${signer.sign(testClaims(NOW_S, { sub }))}`,
  });

  async function claimed(target: ReturnType<typeof buildApp>) {
    await target.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers: as("owner-1") });
    await target.inject({ method: "POST", url: "/v1/orgs/org-a/claim", headers: as("member-1") });
  }

  const connect = (target: ReturnType<typeof buildApp>, sub: string) =>
    target.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: as(sub),
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });

  const offboard = (target: ReturnType<typeof buildApp>, sub: string) =>
    target.inject({
      method: "POST",
      url: "/v1/orgs/org-a/offboard",
      headers: as(sub),
      payload: { confirm: true, exportOffered: true },
    });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(apps.splice(0).map((built) => built.close()));
  });

  it("lets a member connect and offboard when the setting is off, as before", async () => {
    const target = app();
    await claimed(target);
    expect((await connect(target, "member-1")).statusCode).toBe(201);
    expect((await offboard(target, "member-1")).statusCode).toBe(200);
  });

  it("refuses a member, and allows the owner, when the setting is on", async () => {
    vi.stubEnv(OWNER_ONLY_ENV, "1");
    const target = app();
    await claimed(target);

    const refusedConnect = await connect(target, "member-1");
    expect(refusedConnect.statusCode).toBe(403);
    expect(refusedConnect.json()).toMatchObject({ error: "owner_only" });

    const refusedOffboard = await offboard(target, "member-1");
    expect(refusedOffboard.statusCode).toBe(403);
    expect(refusedOffboard.json()).toMatchObject({ error: "owner_only" });

    const created = await connect(target, "owner-1");
    expect(created.statusCode).toBe(201);

    const refusedDelete = await target.inject({
      method: "DELETE",
      url: `/v1/orgs/org-a/connections/${created.json().id}`,
      headers: as("member-1"),
    });
    expect(refusedDelete.statusCode).toBe(403);

    expect((await offboard(target, "owner-1")).statusCode).toBe(200);
  });

  it("leaves reads open to a member when the setting is on", async () => {
    vi.stubEnv(OWNER_ONLY_ENV, "1");
    const target = app();
    await claimed(target);
    const read = await target.inject({
      method: "GET",
      url: "/v1/orgs/org-a/connections",
      headers: as("member-1"),
    });
    expect(read.statusCode).toBe(200);
  });
});
