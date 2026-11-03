import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import {
  DEMO_LABEL,
  DEMO_ORG_ID,
  DEMO_SUBSCRIPTION,
  generateDemoEstate,
  isDemoOrg,
} from "./demo.js";
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

  it("fails the test if any outbound fetch is attempted while demo is active", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("outbound call");
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/orgs/${DEMO_ORG_ID}/estate`,
        headers: DEMO,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().empty).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
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
