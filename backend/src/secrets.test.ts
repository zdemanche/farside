import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { SecretLeakError, assertNoSecrets, secretPaths } from "./secrets.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("no-secrets guard", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, TEST_APP_OPTIONS);

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
    ["numeric password", { password: 12345678 }],
    ["numeric apiKey", { apiKey: 4242424242 }],
    ["tag value PEM", { tags: { owner: "-----BEGIN PRIVATE KEY-----" } }],
    [
      "underscore-prefixed Entra value",
      { note: "_bc8Q~aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ],
    ["tags nested object password", { tags: { a: { password: "hunter2" } } }],
    ["tags array apiKey", { tags: [{ apiKey: "x" }] }],
    ["sasKey key", { sasKey: "x" }],
    ["sasUri key", { sasUri: "x" }],
    ["accountSas key", { accountSas: "x" }],
    ["blobSas key", { blobSas: "x" }],
    [
      "dash-prefixed JWT",
      { note: "x-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" },
    ],
    [
      "dot-prefixed JWT",
      { note: "x.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" },
    ],
    [
      "underscore-prefixed JWT",
      { note: "x_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" },
    ],
    [
      "dash-prefixed Entra",
      { note: "key-abc8Q~aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ],
    [
      "dot-prefixed Entra",
      { note: "key.abc8Q~aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ],
    [
      "key_-prefixed Entra",
      { note: "key_abc8Q~aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ],
    [
      "alphabetic-glued JWT",
      { note: "tokeneyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" },
    ],
    [
      "alphanumeric-glued JWT",
      { note: "abc123eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" },
    ],
    [
      "dot-prefixed JWT start",
      { note: "x.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" },
    ],
    [
      "dash-leading JWT",
      { note: "-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" },
    ],
    [
      "underscore-leading JWT",
      { note: "_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" },
    ],
    [
      "glued match false positive (accepted)",
      { note: "surveyJavascriptBundleLoader.production" },
    ],
    ["JWT value", { note: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaa" }],
  ])("rejects %s", (_name, payload) => {
    expect(() => assertNoSecrets(payload)).toThrow(SecretLeakError);
  });

  it.each([
    ["ownerTagKey", { ownerTagKey: "owner" }],
    ["tokenCount", { tokenCount: 3 }],
    ["budgetCount", { budgetCount: 2 }],
    ["SASWorkload tag", { tags: { SASWorkload: "prod" } }],
    ["secret-rotation tag", { tags: { "secret-rotation": "90d" } }],
    ["TokenBudget tag", { tags: { TokenBudget: "x" } }],
    ["nested tags", { inventory: [{ tags: { sasOwner: "x" } }] }],
    ["sasOwner key", { sasOwner: "team" }],
    ["tenantId", { tenantId: "t", subscriptionId: "s" }],
    ["plain prose", { note: "rotate the secret store quarterly" }],
    ["short sig text", { note: "sig=abc" }],
  ])("accepts %s", (_name, payload) => {
    expect(secretPaths(payload)).toEqual([]);
  });

  it.each([
    ["eyJ".repeat(100_000)],
    ["eyJ-".repeat(50_000)],
    ["aeyJ".repeat(50_000)],
  ])("evaluates a long eyJ run quickly", (note) => {
    const started = performance.now();
    secretPaths({ note });
    expect(performance.now() - started).toBeLessThan(200);
  });
});
