import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { secretPaths } from "./secrets.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const ROUTES = [
  { method: "GET" as const, url: "/v1/orgs/org-a" },
  { method: "GET" as const, url: "/v1/orgs/org-a/inventory" },
  { method: "GET" as const, url: "/v1/orgs/org-a/inventory/no-owner" },
  { method: "GET" as const, url: "/v1/orgs/org-a/connections" },
  { method: "PUT" as const, url: "/v1/orgs/org-a/connections" },
  { method: "PUT" as const, url: "/v1/orgs/org-a/inventory" },
  { method: "GET" as const, url: "/v1/orgs/org-a/coverage" },
  { method: "PUT" as const, url: "/v1/orgs/org-a/coverage" },
  { method: "GET" as const, url: "/v1/orgs/org-a/blind-spots" },
  { method: "GET" as const, url: "/v1/orgs/org-a/estate" },
  { method: "GET" as const, url: "/v1/orgs/org-a/settings" },
  { method: "PUT" as const, url: "/v1/orgs/org-a/settings" },
  { method: "GET" as const, url: "/v1/orgs/org-a/schedule" },
  { method: "POST" as const, url: "/v1/orgs/org-a/schedule/tick" },
  { method: "GET" as const, url: "/v1/orgs/org-a/contract" },
  { method: "PUT" as const, url: "/v1/orgs/org-a/contract" },
  { method: "POST" as const, url: "/v1/orgs/org-a/contract/advance" },
  { method: "POST" as const, url: "/v1/orgs/org-a/offboard" },
  { method: "GET" as const, url: "/v1/orgs/org-a/deletion" },
  { method: "GET" as const, url: "/v1/orgs/org-a/inventory/browse" },
  { method: "GET" as const, url: "/v1/orgs/org-a/scans" },
  { method: "POST" as const, url: "/v1/orgs/org-a/scans" },
  { method: "GET" as const, url: "/v1/orgs/org-a/scans/scan-1" },
  { method: "GET" as const, url: "/v1/orgs/org-a/findings" },
  { method: "GET" as const, url: "/v1/orgs/org-a/issues" },
  { method: "GET" as const, url: "/v1/orgs/org-a/export/issues" },
  { method: "GET" as const, url: "/v1/orgs/org-a/export/inventory" },
  { method: "GET" as const, url: "/v1/orgs/org-a/export/cost" },
  { method: "GET" as const, url: "/v1/orgs/org-a/cost-waste" },
  { method: "GET" as const, url: "/v1/orgs/org-a/headline" },
  { method: "GET" as const, url: "/v1/orgs/org-a/cost" },
  { method: "POST" as const, url: "/v1/orgs/org-a/cost" },
  { method: "GET" as const, url: "/v1/orgs/org-a/commitments" },
  { method: "POST" as const, url: "/v1/orgs/org-a/commitments" },
  { method: "GET" as const, url: "/v1/orgs/org-a/budgets" },
  { method: "POST" as const, url: "/v1/orgs/org-a/budgets" },
  { method: "GET" as const, url: "/v1/orgs/org-a/alerts" },
  { method: "POST" as const, url: "/v1/orgs/org-a/alerts" },
  { method: "DELETE" as const, url: "/v1/orgs/org-a/connections/conn-1" },
];

const OPERATOR_ROUTES = ROUTES.filter((route) => route.url.includes("/contract") && route.method !== "GET");
const SESSION_ROUTES = ROUTES.filter((route) => !OPERATOR_ROUTES.includes(route));

function headers(orgId: string) {
  return { [ORG_HEADER]: orgId, [ACTOR_HEADER]: `actor-${orgId}` };
}

describe("org scoping", async () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, TEST_APP_OPTIONS);
  const inventory = inventoryFromManifest(MANIFEST);

  await store.putInventory("org-a", inventory);
  await store.putConnection("org-a", { tenantId: "tenant-org-a", subscriptionId: "sub-org-a" });
  await store.putConnection("org-b", { tenantId: "tenant-org-b", subscriptionId: "sub-org-b" });

  afterAll(async () => {
    await app.close();
  });

  it.each(SESSION_ROUTES)("returns 401 on $method $url without a session", async (route) => {
    const response = await app.inject({ method: route.method, url: route.url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ title: "Unauthorized", status: 401 });
    expect(secretPaths(response.json())).toEqual([]);
  });

  it.each(ROUTES)("returns 403 on $method $url for a cross-org session", async (route) => {
    const response = await app.inject({
      method: route.method,
      url: route.url,
      headers: headers("org-b"),
      payload: { tenantId: "t", subscriptionId: "s" },
    });
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body).toMatchObject({ title: "Forbidden", status: 403 });
    expect(JSON.stringify(body)).not.toContain("tenant-org-a");
    expect(JSON.stringify(body)).not.toContain("disk-unattached");
    expect(secretPaths(body)).toEqual([]);
  });

  it.each(OPERATOR_ROUTES)("returns 403 on operator route $method $url without the operator token", async (route) => {
    const response = await app.inject({ method: route.method, url: route.url });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ title: "Forbidden", status: 403 });
  });

  it("lets the owning org read its inventory and keeps the other org empty", async () => {
    const own = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory",
      headers: headers("org-a"),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().resources.length).toBe(inventory.resources.length);
    expect(secretPaths(own.json())).toEqual([]);

    const other = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-b/inventory",
      headers: headers("org-b"),
    });
    expect(other.statusCode).toBe(404);
  });

  it("does not list org-a connections to org-b", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-b/connections",
      headers: headers("org-b"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connections: [
        {
          id: "conn-1",
          cloud: "azure",
          tenantId: "tenant-org-b",
          subscriptionId: "sub-org-b",
          roles: ["Reader", "Cost Management Reader", "Monitoring Reader", "Reservations Reader"],
          createdAt: "1970-01-01T00:00:00.000Z",
          healthy: true,
        },
      ],
    });
    expect(JSON.stringify(response.json())).not.toContain("tenant-org-a");
  });

  it("deletes only the named org connection", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-b/connections",
      headers: headers("org-b"),
      payload: { tenantId: "tenant-keep-b", subscriptionId: "sub-keep-b" },
    });
    expect(created.statusCode).toBe(201);
    const keepId = created.json().id as string;

    const removed = await app.inject({
      method: "DELETE",
      url: "/v1/orgs/org-a/connections/conn-1",
      headers: headers("org-a"),
    });
    expect(removed.statusCode).toBe(204);

    const orgA = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/connections",
      headers: headers("org-a"),
    });
    expect(orgA.json().connections).toEqual([]);

    const orgB = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-b/connections",
      headers: headers("org-b"),
    });
    expect(orgB.json().connections.map((row: { id: string }) => row.id)).toContain(keepId);
    expect(orgB.json().connections.map((row: { tenantId: string }) => row.tenantId)).toContain(
      "tenant-org-b",
    );
  });
});
