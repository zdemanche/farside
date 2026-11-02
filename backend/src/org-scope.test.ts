import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { secretPaths } from "./secrets.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const ROUTES = [
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
  { method: "GET" as const, url: "/v1/orgs/org-a/inventory/browse" },
  { method: "DELETE" as const, url: "/v1/orgs/org-a/connections/conn-1" },
];

function headers(orgId: string) {
  return { [ORG_HEADER]: orgId, [ACTOR_HEADER]: `actor-${orgId}` };
}

describe("org scoping", () => {
  const store = new MemoryStore();
  const app = buildApp(store);
  const inventory = inventoryFromManifest(MANIFEST);

  store.putInventory("org-a", inventory);
  store.putConnection("org-a", { tenantId: "tenant-org-a", subscriptionId: "sub-org-a" });
  store.putConnection("org-b", { tenantId: "tenant-org-b", subscriptionId: "sub-org-b" });

  afterAll(async () => {
    await app.close();
  });

  it.each(ROUTES)("returns 401 on $method $url without a session", async (route) => {
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
          tenantId: "tenant-org-b",
          subscriptionId: "sub-org-b",
          roles: ["Reader", "Cost Management Reader", "Monitoring Reader", "Reservations Reader"],
          createdAt: "1970-01-01T00:00:00.000Z",
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
