import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import {
  EXPORT_FORMAT,
  exportCost,
  exportInventory,
  exportIssues,
  validateExport,
} from "./export.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const OTHER = { [ORG_HEADER]: "org-b", [ACTOR_HEADER]: "actor-b" };
const T0 = "2026-10-01T00:00:00.000Z";

const fail: Finding = {
  checkId: "azure-waste-unattached-disks",
  result: "fail",
  evidence: { fields: { diskId: "disk-unattached", diskState: "Unattached" } },
  scope: { id: "main:azure-waste-unattached-disks", cloud: "azure", subscriptionOrProject: "main" },
  savings: { min: "8.00", max: "12.00", currency: "USD" },
};

describe("export format", () => {
  it("emits a fixed envelope and rejects raw provider payload keys", () => {
    const inventory = inventoryFromManifest(MANIFEST);
    const issues = exportIssues(
      "org-a",
      [
        {
          id: "issue-1",
          checkId: fail.checkId,
          resourceId: "disk-unattached",
          scopeId: fail.scope.id,
          cloud: "azure",
          subscriptionOrProject: "main",
          status: "open",
          evidence: { diskId: "disk-unattached" },
          coverage: "assessed",
          firstSeen: T0,
          lastConfirmed: T0,
          savings: fail.savings,
        },
      ],
      T0,
    );
    const inventoryExport = exportInventory("org-a", inventory, T0);
    const costExport = exportCost(
      "org-a",
      {
        subscriptionId: "main",
        billingScope: "/subscriptions/main",
        currency: "USD",
        agreementType: "MicrosoftCustomerAgreement",
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        asOf: T0,
        provisionalDate: null,
        services: [
          {
            billingScope: "/subscriptions/main",
            currency: "USD",
            agreementType: "MicrosoftCustomerAgreement",
            serviceName: "Storage",
            periodStart: "2026-09-01",
            periodEnd: "2026-09-30",
            costAmount: "12.00",
            provisional: false,
          },
        ],
        months: [],
        monthOnMonth: [],
      },
      T0,
    );
    expect(validateExport(issues)).toEqual([]);
    expect(validateExport(inventoryExport)).toEqual([]);
    expect(validateExport(costExport)).toEqual([]);
    expect(issues.format).toBe(EXPORT_FORMAT);
    expect(issues.rows[0]).toMatchObject({
      id: "issue-1",
      coverage: "assessed",
      resourceId: "disk-unattached",
    });
    expect(JSON.stringify(issues)).not.toMatch(/armBody|sdkResponse|"payload"/);
    expect(JSON.stringify(inventoryExport)).not.toMatch(/armBody|sdkResponse|"payload"/);
    expect(validateExport({ ...issues, payload: { armBody: true } }).some((error) => error.includes("payload"))).toBe(
      true,
    );
  });
});

describe("export routes", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, TEST_APP_OPTIONS);

  afterAll(async () => {
    await app.close();
  });

  it("exports the owning org only and refuses a cross-org session", async () => {
    await store.putInventory("org-a", inventoryFromManifest(MANIFEST));
    await store.putIssues("org-a", [
      {
        id: "issue-1",
        checkId: fail.checkId,
        resourceId: "disk-unattached",
        scopeId: fail.scope.id,
        cloud: "azure",
        subscriptionOrProject: "main",
        status: "open",
        evidence: { diskId: "disk-unattached" },
        coverage: "assessed",
        firstSeen: T0,
        lastConfirmed: T0,
      },
    ]);
    await store.putCost("org-a", {
      subscriptionId: "main",
      billingScope: "/subscriptions/main",
      currency: "USD",
      agreementType: "MicrosoftCustomerAgreement",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      asOf: T0,
      provisionalDate: null,
      services: [
        {
          billingScope: "/subscriptions/main",
          currency: "USD",
          agreementType: "MicrosoftCustomerAgreement",
          serviceName: "Storage",
          periodStart: "2026-09-01",
          periodEnd: "2026-09-30",
          costAmount: "12.00",
          provisional: false,
        },
      ],
      months: [],
      monthOnMonth: [],
    });
    await store.putInventory("org-b", {
      cloud: "azure",
      observedAt: T0,
      resources: [],
    });

    const issues = await app.inject({
      method: "GET",
      url: `/v1/orgs/org-a/export/issues?asOf=${encodeURIComponent(T0)}`,
      headers: ORG,
    });
    expect(issues.statusCode).toBe(200);
    expect(issues.headers["content-disposition"]).toContain("farside-issues.json");
    expect(validateExport(issues.json())).toEqual([]);
    expect(issues.json().rows).toHaveLength(1);
    expect(JSON.stringify(issues.json())).not.toContain("org-b");
    expect(JSON.stringify(issues.json())).not.toMatch(/armBody|sdkResponse|"payload"/);

    const inventory = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/export/inventory",
      headers: ORG,
    });
    expect(inventory.statusCode).toBe(200);
    expect(validateExport(inventory.json())).toEqual([]);
    expect(inventory.json().rows.length).toBeGreaterThan(0);
    expect(inventory.json().rows[0]).toEqual(
      expect.objectContaining({
        resourceUri: expect.stringContaining("/subscriptions/"),
        resourceType: expect.any(String),
      }),
    );

    const cost = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/export/cost",
      headers: ORG,
    });
    expect(cost.statusCode).toBe(200);
    expect(validateExport(cost.json())).toEqual([]);
    expect(cost.json().rows[0]).toMatchObject({
      billingScope: "/subscriptions/main",
      currency: "USD",
      amount: "12.00",
    });

    const refused = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/export/issues",
      headers: OTHER,
    });
    expect(refused.statusCode).toBe(403);
    expect(JSON.stringify(refused.json())).not.toContain("disk-unattached");
  });
});
