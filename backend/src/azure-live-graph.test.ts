import { describe, expect, it, vi } from "vitest";
import { ARM_ORIGIN, type FetchLike } from "./azure-live.js";
import {
  ARG_URL,
  liveHierarchyClient,
  liveProtectedItems,
  liveResourceGraphClient,
  liveRoleLister,
  normaliseLiveRow,
} from "./azure-live-graph.js";
import { FAKE_CLIENT_ID, FAKE_PRINCIPAL_ID, FAKE_SUBSCRIPTIONS, FAKE_TENANT_ID, fakeAzure, fakeJwt } from "./azure-fake.js";
import { federatedTokenProviders } from "./azure-federated.js";
import { discoverHierarchy } from "./hierarchy.js";
import { ResourceGraphFailedCallError, ResourceGraphThrottleError, harvestResourceGraph, typeQuery } from "./resource-graph.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const MAIN = FAKE_SUBSCRIPTIONS.main;

function liveArm() {
  const azure = fakeAzure({ now: () => NOW });
  const tokenFor = federatedTokenProviders({ clientId: FAKE_CLIENT_ID, assertion: async () => fakeJwt({ sub: "rt" }), fetch: azure.fetch });
  return { azure, tokenFor, arm: { token: tokenFor(FAKE_TENANT_ID), fetch: azure.fetch, now: () => NOW } };
}

describe("live Resource Graph client", () => {
  it("posts the subscription-scoped query and follows $skipToken across pages", async () => {
    const { azure, arm } = liveArm();
    const harvest = await harvestResourceGraph({ client: liveResourceGraphClient(arm), subscriptionId: MAIN, observedAt: NOW.toISOString() });
    expect(harvest.ok).toBe(true);
    const graphCalls = azure.calls.filter((call) => call.url === ARG_URL);
    const first = JSON.parse(graphCalls[0]?.body ?? "{}") as { subscriptions: string[]; query: string; options: Record<string, unknown> };
    expect(first.subscriptions).toEqual([MAIN]);
    expect(first.query).toBe(typeQuery("Microsoft.Compute/disks"));
    expect(first.options).toMatchObject({ resultFormat: "objectArray", $top: 1000 });
    expect(graphCalls.some((call) => call.body.includes('"$skipToken":"3"'))).toBe(true);
    const names = harvest.inventory.resources.map((resource) => resource.displayName);
    expect(names).toContain("vm-prod-backed-up");
    expect(names).not.toContain("master");
  });

  it("derives the fact fields the checks read from the aliased columns", async () => {
    const { arm } = liveArm();
    const harvest = await harvestResourceGraph({ client: liveResourceGraphClient(arm), subscriptionId: MAIN });
    const fields = (name: string) => harvest.facts.find((fact) => fact.resourceUri.endsWith(`/${name}`))?.fields ?? {};
    expect(fields("vm-stopped-allocated").powerState).toBe("stopped");
    expect(fields("snapshot-old").ageDays).toBe(90);
    expect(fields("cert-app-expiring").daysRemaining).toBe(20);
    expect(fields("lb-busy").backendAddressCount).toBe(2);
    expect(fields("lb-idle").backendAddressCount).toBe(0);
    expect(fields("lb-idle")).not.toHaveProperty("backendPools");
    expect(fields("pip-unassociated").associatedTo).toBeNull();
    expect(fields("cert-gateway-expiring")).not.toHaveProperty("daysRemaining");
  });

  it("keeps throttling apart from other failures", async () => {
    const throttled = liveResourceGraphClient({ token: async () => "t", fetch: async () => new Response("{}", { status: 429 }), sleep: async () => undefined });
    await expect(throttled.query({ subscriptionId: MAIN, query: "Resources" })).rejects.toBeInstanceOf(ResourceGraphThrottleError);
    const refused = liveResourceGraphClient({ token: async () => "t", fetch: async () => new Response("{}", { status: 403 }) });
    await expect(refused.query({ subscriptionId: MAIN, query: "Resources" })).rejects.toBeInstanceOf(ResourceGraphFailedCallError);
    const malformed = liveResourceGraphClient({ token: async () => "t", fetch: async () => new Response("{}") });
    await expect(malformed.query({ subscriptionId: MAIN, query: "Resources" })).rejects.toBeInstanceOf(ResourceGraphFailedCallError);
    await expect(malformed.query({ subscriptionId: "../x", query: "Resources" })).rejects.toThrow();
  });

  it("drops rows without an id or type and non-scalar columns", () => {
    expect(normaliseLiveRow({ type: "x" }, NOW)).toBeNull();
    const row = normaliseLiveRow({ id: "/subscriptions/s/x", type: "t", name: "n", nested: { a: 1 }, flag: true, tags: { owner: "me", bad: 1 } }, NOW);
    expect(row).toEqual({ id: "/subscriptions/s/x", type: "t", name: "n", location: "", subscriptionId: "", tags: { owner: "me" }, properties: { flag: true } });
  });
});

describe("live hierarchy, backup and roles", () => {
  it("lists management groups and subscriptions from ResourceContainers", async () => {
    const { arm } = liveArm();
    const hierarchy = await discoverHierarchy(liveHierarchyClient(arm));
    expect(hierarchy.tenantId).toBe(FAKE_TENANT_ID);
    expect(hierarchy.managementGroups).toEqual([
      { id: FAKE_TENANT_ID, displayName: "Tenant Root Group", parentId: null },
      { id: "mg-farside-test", displayName: "Farside test estate", parentId: FAKE_TENANT_ID },
    ]);
    expect(hierarchy.subscriptions.map((item) => item.id).sort()).toEqual(Object.values(FAKE_SUBSCRIPTIONS).sort());
  });

  it("maps protected items to lower-case source resource ids", async () => {
    const { arm } = liveArm();
    const items = await liveProtectedItems(arm, MAIN);
    const keys = [...items.keys()];
    expect(keys.some((key) => key.endsWith("/vm-prod-backed-up"))).toBe(true);
    expect(keys.some((key) => key.endsWith("/vm-prod-no-backup"))).toBe(false);
    expect(keys.every((key) => key === key.toLowerCase())).toBe(true);
  });

  it("lists role names for the token's service principal", async () => {
    const { azure, tokenFor } = liveArm();
    const roles = await liveRoleLister({ tokenFor, fetch: azure.fetch }).list({ tenantId: FAKE_TENANT_ID, subscriptionId: MAIN, cloud: "azure" });
    expect(roles).toEqual(["Backup Reader", "Cost Management Reader", "Monitoring Reader", "Reader", "Reservations Reader"]);
    const assignments = azure.calls.find((call) => call.url.includes("roleAssignments"));
    expect(decodeURIComponent(assignments?.url ?? "")).toContain(`assignedTo('${FAKE_PRINCIPAL_ID}')`);
    expect(azure.calls.every((call) => call.url.startsWith(ARM_ORIGIN) || call.url.includes("login.microsoftonline.com"))).toBe(true);
  });

  it("reports no roles when the listing is refused and defers other clouds", async () => {
    const azure = fakeAzure({ now: () => NOW, fail: { roles: 403 } });
    const tokenFor = federatedTokenProviders({ clientId: FAKE_CLIENT_ID, assertion: async () => fakeJwt({}), fetch: azure.fetch });
    const fallback = { list: vi.fn(async () => ["roles/viewer"]) };
    const lister = liveRoleLister({ tokenFor, fetch: azure.fetch, fallback });
    expect(await lister.list({ tenantId: FAKE_TENANT_ID, subscriptionId: MAIN, cloud: "azure" })).toEqual([]);
    expect(await lister.list({ tenantId: "t", subscriptionId: "p", cloud: "gcp" })).toEqual(["roles/viewer"]);
  });

  it("refuses a token with no object id", async () => {
    const fetch = vi.fn<FetchLike>();
    const lister = liveRoleLister({ tokenFor: () => async () => fakeJwt({ tid: "t" }), fetch });
    await expect(lister.list({ tenantId: FAKE_TENANT_ID, subscriptionId: MAIN, cloud: "azure" })).rejects.toThrow(/object id/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
