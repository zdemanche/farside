import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { FederatedExchangeError } from "./azure-federated.js";
import { grantedRoleLister, type RoleLister } from "./role-probe.js";
import { REQUIRED_AZURE_ROLES } from "./roles.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { TEST_APP_OPTIONS } from "./test-clock.js";

const HEADERS = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const PAYLOAD = { tenantId: "tenant-1", subscriptionId: "main" };

function refusing(error: Error): RoleLister {
  return {
    list: async () => {
      throw error;
    },
  };
}

/** Answers like a healthy lister until `fail` is set, so a stored connection can then meet a refusal. */
function switchable(): RoleLister & { fail: (error: Error) => void } {
  const healthy = grantedRoleLister([...REQUIRED_AZURE_ROLES]);
  let error: Error | null = null;
  return {
    list: async (input) => {
      if (error) {
        throw error;
      }
      return healthy.list(input);
    },
    fail: (next) => {
      error = next;
    },
  };
}

describe("Connect when Azure refuses the federated token", () => {
  const store = new MemoryStore();
  const apps: Array<ReturnType<typeof buildApp>> = [];

  function appWith(roleLister: RoleLister, withStore = new MemoryStore()) {
    const app = buildApp(withStore, { ...TEST_APP_OPTIONS, roleLister });
    apps.push(app);
    return app;
  }

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it("answers 502 with the cause and a credential hint for a 4xx refusal, and stores nothing", async () => {
    const app = appWith(refusing(new FederatedExchangeError(401, "AADSTS70021")), store);
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: HEADERS,
      payload: PAYLOAD,
    });
    expect(response.statusCode).toBe(502);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      title: "Azure refused the federated sign-in for this tenant",
      status: 502,
      detail: "Entra refused the federated token exchange (HTTP 401, AADSTS70021)",
      errors: [{ path: "tenantId", message: expect.stringContaining("federated credential") }],
    });
    expect((await store.read("org-a", "connections")).connections).toEqual([]);
  });

  it("states the status alone when Entra gave no code", async () => {
    const app = appWith(refusing(new FederatedExchangeError(400, null)));
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: HEADERS,
      payload: PAYLOAD,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().detail).toBe("Entra refused the federated token exchange (HTTP 400)");
  });

  it.each([
    ["a server error", new FederatedExchangeError(503, null)],
    ["a throttle", new FederatedExchangeError(429, null)],
    ["a malformed response", new FederatedExchangeError(502, "malformed_token_response")],
  ])("says to retry, not to fix the credential, for %s", async (_name, error) => {
    const app = appWith(refusing(error));
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: HEADERS,
      payload: PAYLOAD,
    });
    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.title).toBe("Azure sign-in is unavailable for this tenant");
    expect(body.errors[0].message).toContain("Try again");
    expect(JSON.stringify(body)).not.toContain("federated credential");
  });

  it("still answers 500, with no detail, for any other failure", async () => {
    const app = appWith(refusing(new Error("something else broke: secret-value")));
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: HEADERS,
      payload: PAYLOAD,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty("detail");
    expect(response.body).not.toContain("secret-value");
  });

  it("answers 502 on the role re-check and leaves the stored connection as it was", async () => {
    const lister = switchable();
    const checkStore = new MemoryStore();
    const app = appWith(lister, checkStore);
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: HEADERS,
      payload: PAYLOAD,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const before = (await checkStore.read("org-a", "connections")).connections;

    lister.fail(new FederatedExchangeError(401, "AADSTS700016"));
    const response = await app.inject({
      method: "POST",
      url: `/v1/orgs/org-a/connections/${id}/roles`,
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().detail).toBe(
      "Entra refused the federated token exchange (HTTP 401, AADSTS700016)",
    );
    expect((await checkStore.read("org-a", "connections")).connections).toEqual(before);
  });

  it("still answers 500 on the role re-check for any other failure", async () => {
    const lister = switchable();
    const app = appWith(lister);
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: HEADERS,
      payload: PAYLOAD,
    });
    lister.fail(new Error("something else broke"));
    const response = await app.inject({
      method: "POST",
      url: `/v1/orgs/org-a/connections/${created.json().id}/roles`,
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(500);
  });
});
