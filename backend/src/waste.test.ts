import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "@farside/scan-contracts";
import { replayFixture } from "./alerts.js";
import { buildApp } from "./app.js";
import { fixtureBudgetClient } from "./budgets.js";
import { fixtureCommitmentClient } from "./commitments.js";
import { fixtureCostClient } from "./cost.js";
import { recordCoverageScope } from "./coverage.js";
import { fixtureHarvester } from "./scans.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { costWasteView, wasteTotals } from "./waste.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { factsFromManifest } from "./facts.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

const fail: Finding = {
  checkId: "azure-waste-unattached-disks",
  result: "fail",
  evidence: { fields: { diskId: "disk-unattached", diskState: "Unattached" } },
  scope: { id: "main:azure-waste-unattached-disks", cloud: "azure", subscriptionOrProject: "main" },
  savings: { min: "8.00", max: "12.00", currency: "USD" },
};

describe("waste totals", () => {
  it("sums assessed waste ranges and leaves unassessed scopes out of the total", () => {
    const assessed = recordCoverageScope({
      subscriptionOrProject: "main",
      checkId: "azure-waste-unattached-disks",
      state: "assessed",
    });
    const unassessed = recordCoverageScope({
      subscriptionOrProject: "main",
      checkId: "azure-waste-old-snapshots",
      state: "unassessed",
      causeId: "not_run",
    });
    const unreadFail: Finding = {
      ...fail,
      checkId: "azure-waste-old-snapshots",
      scope: { id: "main:azure-waste-old-snapshots", cloud: "azure", subscriptionOrProject: "main" },
      evidence: { fields: { snapshotId: "snapshot-old" } },
      savings: { min: "50.00", max: "90.00", currency: "USD" },
    };
    const totals = wasteTotals([fail, unreadFail], [assessed, unassessed]);
    expect(totals).toEqual({
      min: "8.00",
      max: "12.00",
      currency: "USD",
      assessedCount: 1,
      unassessedScopes: 1,
    });
    const view = costWasteView({
      cost: null,
      alerts: null,
      commitments: null,
      findings: [fail, unreadFail],
      coverage: [assessed, unassessed],
    });
    expect(view.readable).toBe(false);
    expect(view.reason).toBe("cost could not be read");
    expect(view.spend).toBeNull();
    expect(view.waste).toHaveLength(1);
    expect(view.waste[0]?.issueHref).toBe("#issues/disk-unattached");
  });

  it("includes assessed GCP waste ranges in the same totals", () => {
    const gcpFail: Finding = {
      checkId: "gcp-waste-unattached-disks",
      result: "fail",
      evidence: { fields: { diskId: "disk-parked", usersCount: 0 } },
      scope: {
        id: "farside-test:gcp-waste-unattached-disks",
        cloud: "gcp",
        subscriptionOrProject: "farside-test",
      },
      savings: { min: "4.00", max: "6.00", currency: "USD" },
    };
    const assessed = recordCoverageScope({
      subscriptionOrProject: "farside-test",
      checkId: "gcp-waste-unattached-disks",
      state: "assessed",
    });
    expect(wasteTotals([gcpFail], [assessed])).toEqual({
      min: "4.00",
      max: "6.00",
      currency: "USD",
      assessedCount: 1,
      unassessedScopes: 0,
    });
    expect(costWasteView({
      cost: null,
      alerts: null,
      commitments: null,
      findings: [gcpFail],
      coverage: [assessed],
    }).waste[0]?.resourceId).toBe("disk-parked");
  });
});

describe("cost-waste route", () => {
  const store = new MemoryStore(fixedClock);
  store.putConnection("org-a", { tenantId: "tenant-1", subscriptionId: "main" });
  const app = buildApp(store, {
    ...TEST_APP_OPTIONS,
    harvester: fixtureHarvester(inventoryFromManifest(MANIFEST), factsFromManifest(MANIFEST)),
    costClient: fixtureCostClient(),
    commitmentClient: fixtureCommitmentClient(),
    budgetClient: fixtureBudgetClient(),
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns spend, commitments and assessed waste after harvests", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (store.snapshot("org-a").findings.length > 0) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/commitments",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/alerts",
      headers: ORG,
      payload: { rows: replayFixture().rows, asOf: replayFixture().asOf },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/cost-waste",
      headers: ORG,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().readable).toBe(true);
    expect(response.json().spend.services.length).toBeGreaterThan(0);
    expect(response.json().floorBurst.length).toBeGreaterThan(0);
    expect(response.json().commitments.reservations.length).toBeGreaterThan(0);
    expect(response.json().totals.unassessedScopes).toBeGreaterThanOrEqual(0);
    expect(response.json().waste.every((item: { savings: unknown }) => item.savings)).toBe(true);
  });
});
