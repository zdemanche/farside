import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import {
  DEMO_LABEL,
  DEMO_ORG_ID,
  DEMO_SUBSCRIPTION,
  ProviderCallBlockedError,
  generateDemoEstate,
  guardHarvester,
  guardProviderClient,
  isDemoOrg,
} from "./demo.js";
import { ScanRunner } from "./scans.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const DEMO = { [ORG_HEADER]: DEMO_ORG_ID, [ACTOR_HEADER]: "actor-demo" };
const CUSTOMER = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("synthetic demo estate", () => {
  it("validates inventory and findings and uses invented names only", () => {
    const estate = generateDemoEstate();
    expect(estate.inventory.resources.some((resource) => resource.displayName.includes("Parked"))).toBe(
      true,
    );
    expect(estate.findings.length).toBeGreaterThan(0);
    expect(estate.issues.length).toBeGreaterThan(0);
    expect(estate.cost.months.length).toBe(2);
    expect(JSON.stringify(estate)).not.toMatch(/moonaan|dashmeta|atlas|\baif\b|zdemanche/i);
  });
});

describe("demo org mode", () => {
  const store = new MemoryStore(fixedClock);
  const outbound = vi.fn(() => {
    throw new Error("outbound call");
  });
  const app = buildApp(store, { ...TEST_APP_OPTIONS,
    harvester: { harvest: outbound },
    costClient: { query: outbound },
    commitmentClient: { list: outbound },
    budgetClient: { list: outbound },
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    outbound.mockClear();
  });

  it("serves a labelled demo org and never calls injected provider clients", async () => {
    const descriptor = await app.inject({ method: "GET", url: `/v1/orgs/${DEMO_ORG_ID}`, headers: DEMO });
    expect(descriptor.statusCode).toBe(200);
    expect(descriptor.json()).toEqual({ orgId: DEMO_ORG_ID, demo: true, label: DEMO_LABEL });
    const inventory = await app.inject({
      method: "GET",
      url: `/v1/orgs/${DEMO_ORG_ID}/inventory`,
      headers: DEMO,
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().resources.some((row: { displayName: string }) => row.displayName.includes("Harbor"))).toBe(
      true,
    );
    const cost = await app.inject({
      method: "POST",
      url: `/v1/orgs/${DEMO_ORG_ID}/cost`,
      headers: DEMO,
      payload: { subscriptionId: DEMO_SUBSCRIPTION },
    });
    expect(cost.statusCode).toBe(200);
    expect(cost.json().harvested).toBe(true);
    const scan = await app.inject({
      method: "POST",
      url: `/v1/orgs/${DEMO_ORG_ID}/scans`,
      headers: DEMO,
      payload: { subscriptionId: DEMO_SUBSCRIPTION },
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().scanStarted).toBe(false);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects every non-canned mutating route on the demo org and still serves it afterwards", async () => {
    const mutating = [
      { method: "PUT" as const, url: "/connections", payload: { tenantId: "t", subscriptionId: "real-sub" } },
      {
        method: "PUT" as const,
        url: "/inventory",
        payload: { cloud: "azure", observedAt: "2026-10-15T12:00:00.000Z", resources: [] },
      },
      {
        method: "PUT" as const,
        url: "/settings",
        payload: { ownerTagKey: "o", productionTagKey: "e", productionTagValue: "p" },
      },
      {
        method: "PUT" as const,
        url: "/coverage",
        payload: { checkId: "c", subscriptionOrProject: "s", state: "assessed" },
      },
      { method: "PUT" as const, url: "/contract", payload: { plan: "x", startDate: "2026-10-01T00:00:00.000Z" } },
      { method: "POST" as const, url: "/contract/advance", payload: { event: "paid" } },
      { method: "POST" as const, url: "/schedule/tick", payload: { now: "2026-10-15T12:00:00.000Z" } },
      { method: "POST" as const, url: "/offboard", payload: { confirm: true, exportOffered: true } },
      { method: "DELETE" as const, url: "/connections/conn-1", payload: undefined },
    ];
    for (const route of mutating) {
      const response = await app.inject({
        method: route.method,
        url: `/v1/orgs/${DEMO_ORG_ID}${route.url}`,
        headers: DEMO,
        ...(route.payload ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, `${route.method} ${route.url}`).toBeLessThan(500);
    }
    expect(outbound).not.toHaveBeenCalled();
    expect(await store.deletion(DEMO_ORG_ID)).toBeNull();
    const after = await app.inject({ method: "GET", url: `/v1/orgs/${DEMO_ORG_ID}`, headers: DEMO });
    expect(after.statusCode).toBe(200);
    const estate = await app.inject({ method: "GET", url: `/v1/orgs/${DEMO_ORG_ID}/estate`, headers: DEMO });
    expect(estate.json().empty).toBe(false);
  });

  it("throws ProviderCallBlockedError from the real client interfaces for the demo org only", async () => {
    const harvester = { harvest: vi.fn(async () => ({ inventory: null })) };
    const costClient = { query: vi.fn(async () => ({ rows: [] })) };
    const guardedHarvester = guardHarvester(harvester as never);
    expect(() =>
      guardedHarvester.harvest({ orgId: DEMO_ORG_ID, subscriptionId: "real-sub", settings: {} as never }),
    ).toThrow(ProviderCallBlockedError);
    expect(() => guardProviderClient(DEMO_ORG_ID, costClient).query()).toThrow(ProviderCallBlockedError);
    expect(harvester.harvest).not.toHaveBeenCalled();
    expect(costClient.query).not.toHaveBeenCalled();
    await guardProviderClient("org-a", costClient).query();
    expect(costClient.query).toHaveBeenCalledTimes(1);
  });

  it("blocks the commitment and budget clients for the demo org", () => {
    const commitmentClient = { list: vi.fn(async () => ({})) };
    const budgetClient = { list: vi.fn(async () => []) };
    expect(() => guardProviderClient(DEMO_ORG_ID, commitmentClient).list()).toThrow(ProviderCallBlockedError);
    expect(() => guardProviderClient(DEMO_ORG_ID, budgetClient).list()).toThrow(ProviderCallBlockedError);
    expect(commitmentClient.list).not.toHaveBeenCalled();
    expect(budgetClient.list).not.toHaveBeenCalled();
  });

  it("fails a demo scan before the harvester when a runner uses the guarded harvester", async () => {
    const harvest = vi.fn();
    const runner = new ScanRunner(new MemoryStore(), guardHarvester({ harvest }));
    const started = await runner.start({ orgId: DEMO_ORG_ID, subscriptionId: "real-sub", actor: "user" });
    const job = await started.done;
    expect(job.status).toBe("failed");
    expect(harvest).not.toHaveBeenCalled();
  });

  it("never copies demo resources into a customer org", async () => {
    await app.inject({ method: "GET", url: `/v1/orgs/${DEMO_ORG_ID}/inventory`, headers: DEMO });
    const customer = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory",
      headers: CUSTOMER,
    });
    expect(customer.statusCode).toBe(404);
    expect(isDemoOrg("org-a")).toBe(false);
    expect(JSON.stringify(store.snapshot("org-a"))).not.toContain("disk-parked");
    expect(JSON.stringify(store.snapshot("org-a"))).not.toContain("lumen-east");
  });
});
