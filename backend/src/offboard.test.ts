import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { GRANTS_TO_REMOVE } from "./offboard.js";
import { addHours } from "./scheduler.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

describe("offboard", () => {
  const store = new MemoryStore();
  const app = buildApp(store);

  afterAll(async () => {
    await app.close();
  });

  it("deletes org rows, stops a pending schedule, and keeps a deletion record", async () => {
    store.putInventory("org-a", inventoryFromManifest(MANIFEST));
    store.putFindings("org-a", [fail]);
    store.putIssues("org-a", [
      {
        id: "issue-1",
        checkId: fail.checkId,
        resourceId: "disk-unattached",
        scopeId: fail.scope.id,
        subscriptionOrProject: "main",
        status: "open",
        evidence: { diskId: "disk-unattached" },
        coverage: "assessed",
        firstSeen: T0,
        lastConfirmed: T0,
      },
    ]);
    store.putCost("org-a", {
      subscriptionId: "main",
      billingScope: "/subscriptions/main",
      currency: "USD",
      agreementType: "MicrosoftCustomerAgreement",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      asOf: T0,
      provisionalDate: null,
      services: [],
      months: [],
      monthOnMonth: [],
    });
    store.putConnection("org-a", { tenantId: "tenant-a", subscriptionId: "main" });
    store.putConnection("org-b", { tenantId: "tenant-b", subscriptionId: "other" });
    const scheduled = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/settings",
      headers: ORG,
      payload: {
        ownerTagKey: "owner",
        productionTagKey: "environment",
        productionTagValue: "prod",
        scanScheduleEnabled: true,
        scanIntervalHours: 24,
        asOf: T0,
      },
    });
    expect(scheduled.json().nextRunAt).toBe(addHours(T0, 24));
    expect(store.orgRows("org-a")).toBeGreaterThan(0);

    const refused = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/offboard",
      headers: ORG,
      payload: { now: T0 },
    });
    expect(refused.statusCode).toBe(400);
    expect(store.hasOrg("org-a")).toBe(true);

    const offboarded = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/offboard",
      headers: ORG,
      payload: { confirm: true, exportOffered: true, now: T0 },
    });
    expect(offboarded.statusCode).toBe(200);
    expect(offboarded.json()).toMatchObject({
      orgId: "org-a",
      deletedAt: T0,
      connectionsRemoved: 1,
      scansStopped: true,
      scheduleCancelled: true,
      accountClosureAt: null,
    });
    expect(offboarded.json().grantsToRemove).toEqual(GRANTS_TO_REMOVE);
    expect(store.hasOrg("org-a")).toBe(false);
    expect(store.orgRows("org-a")).toBe(0);
    expect(store.deletion("org-a")?.deletedAt).toBe(T0);

    const gone = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
    });
    expect(gone.statusCode).toBe(410);
    expect(gone.json().deletedAt).toBe(T0);

    const recreate = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: inventoryFromManifest(MANIFEST),
    });
    expect(recreate.statusCode).toBe(410);
    expect(store.hasOrg("org-a")).toBe(false);
    expect(store.orgRows("org-a")).toBe(0);

    const tick = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/schedule/tick",
      headers: ORG,
      payload: { now: addHours(T0, 24) },
    });
    expect(tick.statusCode).toBe(410);
    expect(store.hasOrg("org-a")).toBe(false);

    const record = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/deletion",
      headers: ORG,
    });
    expect(record.statusCode).toBe(200);
    expect(record.json().deletedAt).toBe(T0);
    expect(record.json().grantsToRemove.map((grant: { name: string }) => grant.name)).toContain(
      "Reader",
    );

    const other = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-b/connections",
      headers: OTHER,
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().connections).toHaveLength(1);
    expect(store.hasOrg("org-b")).toBe(true);
  });
});
