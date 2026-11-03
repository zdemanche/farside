import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { MAX_TAG_VALUE_LENGTH } from "./inventory.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const T0 = "2026-10-15T12:00:00.000Z";

const store = new MemoryStore(fixedClock);
const app = buildApp(store, TEST_APP_OPTIONS);

afterAll(async () => {
  await app.close();
});

const row = { date: "2026-10-14", subscriptionId: "main", serviceName: "Compute", costAmount: "10.00", currency: "USD" };
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

function post(url: string, payload: unknown, headers: Record<string, string> = ORG) {
  return app.inject({ method: "POST", url: `/v1/orgs/org-a${url}`, headers, payload: payload as object });
}

describe("schema validation answers with the problem+json envelope", () => {
  it.each([
    ["a malformed previous alert", { rows: [row], previous: [{ id: "a1" }] }],
    ["a non-email recipient", { rows: [row], recipients: ["not-an-email"] }],
    ["more than 20 recipients", { rows: [row], recipients: Array.from({ length: 21 }, (_, i) => `u${i}@example.test`) }],
    ["a malformed cost row", { rows: [{ date: "2026-10-14" }] }],
  ])("rejects %s with 400", async (_name, payload) => {
    const response = await post("/alerts", payload);
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ type: "about:blank", title: "Invalid alerts", status: 400 });
    expect(response.json().errors.length).toBeGreaterThan(0);
  });

  it("accepts 20 valid recipients and well-formed previous alerts", async () => {
    const response = await post("/alerts", {
      rows: [row],
      asOf: "2026-10-14",
      recipients: Array.from({ length: 20 }, (_, i) => `u${i}@example.test`),
      previous: [alert],
    });
    expect(response.statusCode).toBe(200);
  });

  it.each([
    ["a path-like subscription id", { tenantId: "t", subscriptionId: "../providers/x" }],
    ["a non-identifier tenant id", { tenantId: "t/../x", subscriptionId: "main" }],
    ["an unknown cloud", { tenantId: "t", subscriptionId: "main", cloud: "aws" }],
    ["a numeric subscription id", { tenantId: "t", subscriptionId: 12 }],
  ])("rejects a connection with %s", async (_name, payload) => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().title).toBe("Invalid connection");
  });

  it("rejects non-integer settings numbers and a malformed offboard time", async () => {
    const settings = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/settings",
      headers: ORG,
      payload: { ownerTagKey: "owner", productionTagKey: "env", productionTagValue: "prod", scanIntervalHours: 0 },
    });
    expect(settings.statusCode).toBe(400);
    expect(settings.json().errors[0].path).toBe("scanIntervalHours");
    const offboard = await post("/offboard", { confirm: true, exportOffered: true, now: "yesterday" });
    expect(offboard.statusCode).toBe(400);
  });

  it("answers 401 before it validates the body", async () => {
    const response = await post("/alerts", { rows: "nope" }, {});
    expect(response.statusCode).toBe(401);
  });

  it("answers 403 before it validates the body for another org", async () => {
    const response = await post("/alerts", { rows: "nope" }, { [ORG_HEADER]: "org-b" });
    expect(response.statusCode).toBe(403);
  });

  it("keeps the 409 for a missing cost series and tolerates an empty tick body", async () => {
    expect((await post("/alerts", {})).statusCode).toBe(409);
    const tick = await app.inject({ method: "POST", url: "/v1/orgs/org-a/schedule/tick", headers: ORG });
    expect(tick.statusCode).toBe(200);
  });

  it("ignores a body actor so a user cannot label a scan as system", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: { tenantId: "tenant-1", subscriptionId: "main", actor: "system", asOf: T0 },
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
    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: {
        cloud: "azure",
        observedAt: T0,
        extra: "dropped",
        resources: [resource],
      },
    });
    expect(put.json()).toMatchObject({ cloud: "azure" });
    const got = await app.inject({ method: "GET", url: "/v1/orgs/org-a/inventory", headers: ORG });
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
    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: {
        cloud: "azure",
        observedAt: T0,
        resources: [{ ...resource, properties: { adminPassword: "x" } }],
      },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().title).toBe("Secret rejected");
  });
});
