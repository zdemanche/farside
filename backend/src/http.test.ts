import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { MAX_TAG_VALUE_LENGTH } from "./inventory.js";
import { ACTOR_HEADER, OPERATOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const DEMO = { [ORG_HEADER]: "demo", [ACTOR_HEADER]: "actor-a" };
const OPERATOR_TOKEN = "operator-secret";
const T0 = "2026-10-15T12:00:00.000Z";

let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  app = buildApp(new MemoryStore(fixedClock), {
    ...TEST_APP_OPTIONS,
    operatorToken: OPERATOR_TOKEN,
  });
});

afterEach(async () => {
  await app.close();
});

const row = {
  date: "2026-10-14",
  subscriptionId: "main",
  serviceName: "Compute",
  costAmount: "10.00",
  currency: "USD",
};
const alert = {
  id: "a1",
  kind: "ORG_SPIKE",
  date: "2026-10-14",
  scope: "org",
  amount: "10.00",
  baseline: "5.00",
  currency: "USD",
  isNew: true,
};

function send(
  method: "POST" | "PUT",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = ORG,
) {
  return app.inject({
    method,
    url: `/v1/orgs/${headers[ORG_HEADER] ?? "org-a"}${url}`,
    headers,
    payload: payload as object,
  });
}

describe("schema validation answers with the problem+json envelope", () => {
  it.each([
    ["a malformed previous alert", { rows: [row], previous: [{ id: "a1" }] }],
    ["a non-email recipient", { rows: [row], recipients: ["not-an-email"] }],
    [
      "more than 20 recipients",
      { rows: [row], recipients: Array.from({ length: 21 }, (_, i) => `u${i}@example.test`) },
    ],
    ["a malformed cost row", { rows: [{ date: "2026-10-14" }] }],
  ])("rejects %s with 400", async (_name, payload) => {
    const response = await send("POST", "/alerts", payload);
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      type: "about:blank",
      title: "Invalid alerts",
      status: 400,
    });
    expect(response.json().errors.length).toBeGreaterThan(0);
  });

  it("accepts 20 valid recipients and well-formed previous alerts", async () => {
    const response = await send("POST", "/alerts", {
      rows: [row],
      asOf: "2026-10-14",
      recipients: Array.from({ length: 20 }, (_, i) => `u${i}@example.test`),
      previous: [alert],
    });
    expect(response.statusCode).toBe(200);
  });

  it("does not echo schema regexes in format errors", async () => {
    const response = await send("PUT", "/connections", { tenantId: "t", subscriptionId: "../x" });
    expect(response.statusCode).toBe(400);
    expect(response.json().errors).toEqual([{ path: "subscriptionId", message: "invalid format" }]);
  });

  it.each([
    ["a path-like subscription id", { tenantId: "t", subscriptionId: "../providers/x" }],
    ["a non-identifier tenant id", { tenantId: "t/../x", subscriptionId: "main" }],
    ["an unknown cloud", { tenantId: "t", subscriptionId: "main", cloud: "aws" }],
    ["a numeric subscription id", { tenantId: "t", subscriptionId: 12 }],
  ])("rejects a connection with %s", async (_name, payload) => {
    const response = await send("PUT", "/connections", payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().title).toBe("Invalid connection");
  });

  it("rejects a non-integer settings number", async () => {
    const response = await send("PUT", "/settings", {
      ownerTagKey: "owner",
      productionTagKey: "env",
      productionTagValue: "prod",
      scanIntervalHours: 7.5,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().title).toBe("Invalid settings");
    expect(response.json().errors[0].path).toBe("scanIntervalHours");
  });

  it("rejects a malformed offboard time, export asOf and advance event", async () => {
    expect(
      (await send("POST", "/offboard", { confirm: true, exportOffered: true, now: "yesterday" }))
        .statusCode,
    ).toBe(400);
    const exported = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/export/cost?asOf=yesterday",
      headers: ORG,
    });
    expect(exported.statusCode).toBe(400);
    expect(exported.json().title).toBe("Invalid request");
    const advance = await send(
      "POST",
      "/contract/advance",
      { event: "exploded" },
      {
        ...ORG,
        [OPERATOR_HEADER]: OPERATOR_TOKEN,
      },
    );
    expect(advance.statusCode).toBe(400);
    expect(advance.json().title).toBe("Invalid contract event");
  });

  it("uses the generic title for params and query errors", async () => {
    const badParam = await app.inject({
      method: "DELETE",
      url: `/v1/orgs/org-a/connections/${"x".repeat(65)}`,
      headers: ORG,
    });
    expect(badParam.statusCode).toBe(400);
    expect(badParam.json().title).toBe("Invalid request");
    const badCloud = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/findings?cloud=aws",
      headers: ORG,
    });
    expect(badCloud.statusCode).toBe(400);
    expect(badCloud.json().title).toBe("Invalid cloud");
  });

  it("answers 401 and 403 before it validates the body", async () => {
    expect((await send("POST", "/alerts", { rows: "nope" }, {})).statusCode).toBe(401);
    const other = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/alerts",
      headers: { [ORG_HEADER]: "org-b" },
      payload: { rows: "nope" },
    });
    expect(other.statusCode).toBe(403);
  });

  it("answers 403 on an operator route before it validates the body", async () => {
    const response = await send("PUT", "/contract", { plan: 7 });
    expect(response.statusCode).toBe(403);
    const operator = await send(
      "PUT",
      "/contract",
      { plan: 7 },
      { ...ORG, [OPERATOR_HEADER]: OPERATOR_TOKEN },
    );
    expect(operator.statusCode).toBe(400);
    expect(operator.json().title).toBe("Invalid contract");
  });

  it.each([
    ["clientSecret", { clientSecret: "x" }],
    ["a PEM value", { note: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }],
  ])("rejects %s on the operator contract route", async (_name, extra) => {
    const response = await send(
      "PUT",
      "/contract",
      { plan: "farside-standard", startDate: T0, ...extra },
      { ...ORG, [OPERATOR_HEADER]: OPERATOR_TOKEN },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().title).toBe("Secret rejected");
  });

  it("rejects a secret-shaped field on an org route", async () => {
    const response = await send("PUT", "/settings", {
      ownerTagKey: "owner",
      productionTagKey: "env",
      productionTagValue: "prod",
      clientSecret: "x",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().title).toBe("Secret rejected");
  });

  it("validates a demo canned POST before the shortcut", async () => {
    expect((await send("POST", "/scans", { subscriptionId: "../x" }, DEMO)).statusCode).toBe(400);
    expect((await send("POST", "/scans", { subscriptionId: "main" }, DEMO)).statusCode).toBe(200);
  });

  it("keeps the 409 for a missing cost series and treats empty or null bodies as {}", async () => {
    expect((await send("POST", "/alerts", {})).statusCode).toBe(409);
    expect((await send("POST", "/schedule/tick")).statusCode).toBe(200);
    const nullTick = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/schedule/tick",
      headers: { ...ORG, "content-type": "application/json" },
      payload: "null",
    });
    expect(nullTick.statusCode).toBe(200);
  });

  it("ignores a body actor so a user cannot label a scan as system", async () => {
    const created = await send("PUT", "/connections", {
      tenantId: "tenant-1",
      subscriptionId: "main",
      actor: "system",
      asOf: T0,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().scan.actor).toBe("user");
  });
});

describe("inventory allow-list projection", () => {
  const resource = {
    resourceUri: "/subscriptions/main/resourceGroups/rg/providers/Microsoft.Compute/disks/d1",
    resourceType: "Microsoft.Compute/disks",
    region: "eastus",
    displayName: "d1",
    tags: { owner: "alice", note: "lorem ".repeat(MAX_TAG_VALUE_LENGTH), count: 7 },
    properties: { diskState: "Unattached" },
    sku: { name: "Premium" },
    identity: { principalId: "p" },
  };

  it("keeps known fields only and caps tag values", async () => {
    const put = await send("PUT", "/inventory", {
      cloud: "azure",
      observedAt: T0,
      extra: "dropped",
      resources: [resource],
    });
    expect(put.statusCode).toBe(200);
    const got = await app.inject({ method: "GET", url: "/v1/orgs/org-a/inventory", headers: ORG });
    expect(got.statusCode).toBe(200);
    const body = got.json();
    expect(Object.keys(body).sort()).toEqual(["cloud", "observedAt", "resources"]);
    const stored = body.resources[0];
    expect(Object.keys(stored).sort()).toEqual([
      "displayName",
      "ownerTag",
      "region",
      "resourceType",
      "resourceUri",
      "tags",
    ]);
    expect(stored.ownerTag).toBe("alice");
    expect(stored.tags.note).toHaveLength(MAX_TAG_VALUE_LENGTH);
    expect(stored.tags).not.toHaveProperty("count");
    expect(JSON.stringify(body)).not.toMatch(/diskState|Premium|principalId/);
  });

  it("still rejects a secret-named provider property outright", async () => {
    const put = await send("PUT", "/inventory", {
      cloud: "azure",
      observedAt: T0,
      resources: [{ ...resource, properties: { adminPassword: "x" } }],
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().title).toBe("Secret rejected");
  });
});
