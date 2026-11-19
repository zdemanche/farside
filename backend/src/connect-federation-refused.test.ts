import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { FederatedExchangeError } from "./azure-federated.js";
import type { RoleLister } from "./role-probe.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { TEST_APP_OPTIONS } from "./test-clock.js";

const HEADERS = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

function refusing(error: Error): RoleLister {
  return {
    list: async () => {
      throw error;
    },
  };
}

describe("Connect when Azure refuses the federated token", () => {
  const store = new MemoryStore();
  const app = buildApp(store, {
    ...TEST_APP_OPTIONS,
    roleLister: refusing(new FederatedExchangeError(401, "AADSTS70021")),
  });
  const other = buildApp(new MemoryStore(), {
    ...TEST_APP_OPTIONS,
    roleLister: refusing(new Error("something else broke")),
  });

  afterAll(async () => {
    await app.close();
    await other.close();
  });

  it("answers 502 with the cause and stores no connection", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: HEADERS,
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      title: "Azure refused the federated sign-in for this tenant",
      status: 502,
      detail: expect.stringContaining("AADSTS70021"),
    });
    expect((await store.read("org-a", "connections")).connections).toEqual([]);
  });

  it("still answers 500 for any other failure", async () => {
    const response = await other.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: HEADERS,
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });
    expect(response.statusCode).toBe(500);
  });
});
