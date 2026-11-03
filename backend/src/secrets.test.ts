import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { SecretLeakError, assertNoSecrets, secretPaths } from "./secrets.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("no-secrets guard", () => {
  const store = new MemoryStore();
  const app = buildApp(store);

  afterAll(async () => {
    await app.close();
  });

  it("fails the build when a stored record contains a client_secret", () => {
    expect(() =>
      store.putConnection("org-a", {
        tenantId: "t",
        subscriptionId: "s",
        client_secret: "not-a-real-secret",
      } as { tenantId: string; subscriptionId: string }),
    ).toThrow(SecretLeakError);
  });

  it("fails when a log line contains a token pattern", () => {
    expect(() =>
      assertNoSecrets({
        msg: "access eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa",
      }),
    ).toThrow(SecretLeakError);
  });

  it("rejects a connection PUT that includes a secret field", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: {
        tenantId: "t",
        subscriptionId: "s",
        clientSecret: "not-a-real-secret",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().title).toBe("Secret rejected");
    expect(store.snapshot("org-a").connections).toEqual([]);
  });

  it("scans stored records and responses for secret patterns", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: { tenantId: "tenant-clean", subscriptionId: "sub-clean" },
    });
    expect(created.statusCode).toBe(201);
    expect(secretPaths(created.json())).toEqual([]);
    expect(secretPaths(store.snapshot("org-a"))).toEqual([]);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
    });
    expect(listed.statusCode).toBe(200);
    expect(secretPaths(listed.json())).toEqual([]);
  });

  it.each([
    ["client-secret key", { "client-secret": "x" }],
    ["token key", { token: "x" }],
    ["authorization key", { authorization: "Bearer x" }],
    ["private_key key", { private_key: "x" }],
    ["connectionString key", { connectionString: "x" }],
    ["accountKey key", { accountKey: "x" }],
    ["sasToken key", { sasToken: "x" }],
    ["nested key", { auth: { bearerToken: "x" } }],
    ["PEM value", { note: "-----BEGIN PRIVATE KEY-----\nabc" }],
    ["RSA PEM value", { note: "-----BEGIN RSA PRIVATE KEY-----" }],
    ["ya29 value", { note: "ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxx" }],
    ["AWS access key value", { note: "AKIAIOSFODNN7EXAMPLE" }],
    [
      "SAS sig value",
      {
        url: "https://a.blob.core.windows.net/c?sv=2022&sig=abcdefghijklmnopqrstuvwxyz%3D",
      },
    ],
    [
      "Entra secret value",
      { note: "Abc8Q~aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ],
    ["JWT value", { note: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" }],
  ])("rejects %s", (_name, payload) => {
    expect(() => assertNoSecrets(payload)).toThrow(SecretLeakError);
  });

  it.each([
    ["ownerTagKey", { ownerTagKey: "owner" }],
    ["tokenCount", { tokenCount: 3 }],
    ["budgetCount", { budgetCount: 2 }],
    ["tenantId", { tenantId: "t", subscriptionId: "s" }],
    ["plain prose", { note: "rotate the secret store quarterly" }],
    ["short sig text", { note: "sig=abc" }],
  ])("accepts %s", (_name, payload) => {
    expect(secretPaths(payload)).toEqual([]);
  });
});
