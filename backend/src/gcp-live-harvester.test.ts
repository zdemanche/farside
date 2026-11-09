import { describe, expect, it, vi } from "vitest";
import { fixtureCloudAssetClient, type CloudAsset } from "./cloud-asset.js";
import manifestJson from "../../docs/gcp/ground-truth.json" with { type: "json" };
import type { GcpGroundTruthManifest } from "./gcp-inventory.js";
import {
  GcpLiveConfigError,
  describeGcpLiveConfig,
  gcpLiveConfigFromEnv,
  liveGcpHarvester,
  overlayServiceReads,
  recommenderZones,
  selectGcpHarvester,
} from "./gcp-live-harvester.js";
import {
  GcpAccessDeniedError,
  GcpAuthError,
  MissingRecommenderRoleError,
  type GcpServiceReads,
} from "./gcp-live.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { secretPaths } from "./secrets.js";

const manifest = manifestJson as GcpGroundTruthManifest;
const ENV = {
  FARSIDE_GCP_LIVE: "1",
  FARSIDE_GCP_PROJECT_ID: "farside-test",
  FARSIDE_GCP_POOL_PROJECT_NUMBER: "123456789",
  FARSIDE_GCP_POOL_ID: "farside-pool",
  FARSIDE_GCP_PROVIDER_ID: "farside-aws",
  FARSIDE_GCP_SERVICE_ACCOUNT: "farside-reader@farside-test.iam.gserviceaccount.com",
  AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/token",
};

const noReads: GcpServiceReads = {
  listSqlInstances: async () => [],
  listGkeClusters: async () => [],
  listCertificates: async () => [],
};

describe("live GCP config", () => {
  it("is off unless FARSIDE_GCP_LIVE=1, so CI and the default path stay on fixtures", () => {
    expect(gcpLiveConfigFromEnv({})).toBeNull();
    expect(gcpLiveConfigFromEnv({ ...ENV, FARSIDE_GCP_LIVE: "true" })).toBeNull();
  });

  it("names every missing setting when switched on incompletely", () => {
    expect(() =>
      gcpLiveConfigFromEnv({ FARSIDE_GCP_LIVE: "1", FARSIDE_GCP_PROJECT_ID: "farside-test" }),
    ).toThrow(GcpLiveConfigError);
    try {
      gcpLiveConfigFromEnv({ FARSIDE_GCP_LIVE: "1" });
    } catch (error) {
      expect((error as GcpLiveConfigError).missing).toContain(
        "FARSIDE_GCP_SUBJECT_TOKEN_FILE or AWS_WEB_IDENTITY_TOKEN_FILE",
      );
    }
  });

  it("prefers FARSIDE_GCP_SUBJECT_TOKEN_FILE and validates the billing table", () => {
    const config = gcpLiveConfigFromEnv({ ...ENV, FARSIDE_GCP_SUBJECT_TOKEN_FILE: "/run/oidc" });
    expect(config).toMatchObject({ subjectTokenPath: "/run/oidc", jobProjectId: "farside-test" });
    expect(() =>
      gcpLiveConfigFromEnv({ ...ENV, FARSIDE_GCP_BILLING_EXPORT_TABLE: "bad" }),
    ).toThrow();
  });

  it("describes the connection without any secret-shaped field", () => {
    const config = gcpLiveConfigFromEnv(ENV);
    expect(config).not.toBeNull();
    const summary = describeGcpLiveConfig(config as NonNullable<typeof config>);
    expect(secretPaths(summary)).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain("/var/run");
  });

  it("selects the fixture harvester by default and the live one only when configured", async () => {
    const fixture = await selectGcpHarvester({}).harvest({
      orgId: "o",
      subscriptionId: "farside-test",
      settings: DEFAULT_SETTINGS,
    });
    expect(fixture.inventory.resources.length).toBe(manifest.items.length);
    const fetch = vi.fn(async () => Response.json({}, { status: 401 }));
    const live = selectGcpHarvester(ENV, undefined, { fetch, readFile: async () => "oidc" });
    // STS refuses the mocked exchange: the live path was taken, and never touched the network.
    await expect(
      live.harvest({ orgId: "o", subscriptionId: "farside-test", settings: DEFAULT_SETTINGS }),
    ).resolves.toMatchObject({
      inventory: { resources: [] },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://sts.googleapis.com/v1/token");
  });
});

const sqlAsset = (
  id: string,
  properties: CloudAsset["properties"],
  labels: Record<string, string> = {},
): CloudAsset => ({
  id,
  name: `//cloudsql.googleapis.com/projects/farside-test/instances/${id}`,
  assetType: "sqladmin.googleapis.com/Instance",
  project: "farside-test",
  displayName: id,
  location: "us-central1",
  labels,
  ...(properties ? { properties } : {}),
});

describe("service read overlay", () => {
  it("fills missing Cloud Asset fields from direct reads and adds assets Cloud Asset has not caught up with", async () => {
    const reads: GcpServiceReads = {
      ...noReads,
      listSqlInstances: async () => [
        sqlAsset(
          "sql-zonal",
          { databaseVersion: "MYSQL_8_0", availabilityType: "ZONAL", backupEnabled: true },
          { owner: "o" },
        ),
        sqlAsset("sql-new", {
          availabilityType: "REGIONAL",
          backupEnabled: true,
          databaseVersion: null,
        }),
      ],
    };
    const out = await overlayServiceReads(
      [
        sqlAsset("sql-zonal", {
          availabilityType: null,
          backupEnabled: null,
          databaseVersion: "MYSQL_8_0",
        }),
      ],
      reads,
      "farside-test",
    );
    expect(out.map((asset) => asset.id)).toEqual(["sql-zonal", "sql-new"]);
    expect(out[0]).toMatchObject({
      labels: { owner: "o" },
      properties: { availabilityType: "ZONAL", backupEnabled: true },
    });
  });

  it("keeps Cloud Asset data on a refused read but surfaces a rejected token", async () => {
    const denied: GcpServiceReads = {
      ...noReads,
      listGkeClusters: async () => {
        throw new GcpAccessDeniedError();
      },
    };
    const kept = [sqlAsset("sql-zonal", { availabilityType: "ZONAL" })];
    expect(await overlayServiceReads(kept, denied, "farside-test")).toEqual(kept);
    const rejected: GcpServiceReads = {
      ...noReads,
      listCertificates: async () => {
        throw new GcpAuthError();
      },
    };
    await expect(overlayServiceReads(kept, rejected, "farside-test")).rejects.toBeInstanceOf(
      GcpAuthError,
    );
  });
});

describe("live GCP harvester", () => {
  const items = manifest.items.filter(
    (item) => item.type !== "recommender.googleapis.com/Recommendation",
  );

  it("asks Recommender in each zone that holds disks or VMs and adds the recommendations to inventory", async () => {
    const list = vi.fn(
      async (input: { projectId: string; location: string; recommenderId: string }) =>
        input.recommenderId.includes("disk")
          ? [
              {
                recommendationId: "r1",
                recommenderId: input.recommenderId,
                resourceName:
                  "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/disks/disk-parked",
                subtype: "IDLE_DISK",
                projectId: input.projectId,
                savingsMin: 8,
                savingsMax: 12,
                currency: "USD",
              },
            ]
          : [],
    );
    const harvest = await liveGcpHarvester(
      {
        cloudAsset: fixtureCloudAssetClient({ items }),
        serviceReads: noReads,
        recommender: { list },
      },
      () => "2026-12-01T00:00:00.000Z",
    ).harvest({ orgId: "o", subscriptionId: "farside-test", settings: DEFAULT_SETTINGS });
    expect(list.mock.calls.map((call) => call[0].location)).toEqual([
      "us-central1-a",
      "us-central1-a",
    ]);
    const rec = harvest.inventory.resources.find(
      (resource) => resource.resourceType === "recommender.googleapis.com/Recommendation",
    );
    expect(rec?.resourceUri).toContain("/recommendations/r1");
    expect(harvest.facts.find((row) => row.resourceUri === rec?.resourceUri)?.fields).toMatchObject(
      { recommendationId: "r1", savingsMax: 12 },
    );
    expect(harvest.inventory.observedAt).toBe("2026-12-01T00:00:00.000Z");
    expect(harvest.coveredScopes).toContain("farside-test:gcp-inventory-all-assets");
  });

  it("marks the Recommender check unassessed on a missing role", async () => {
    const harvest = await liveGcpHarvester({
      cloudAsset: fixtureCloudAssetClient({ items }),
      serviceReads: noReads,
      recommender: {
        list: async () => {
          throw new MissingRecommenderRoleError();
        },
      },
    }).harvest({ orgId: "o", subscriptionId: "farside-test", settings: DEFAULT_SETTINGS });
    expect(
      harvest.coverage.find(
        (entry) => entry.checkId === "gcp-waste-idle-vm-and-disk-recommendations",
      ),
    ).toMatchObject({
      state: "unassessed",
      causeId: "missing_role",
    });
  });

  it("finds recommender zones only from zonal disks and VMs", () => {
    const zones = recommenderZones([
      {
        ...sqlAsset("s", {}),
        assetType: "compute.googleapis.com/Disk",
        location: "europe-west2-b",
      },
      { ...sqlAsset("t", {}), assetType: "compute.googleapis.com/Address", location: "us-east1-c" },
      {
        ...sqlAsset("u", {}),
        assetType: "compute.googleapis.com/Instance",
        location: "us-central1",
      },
    ]);
    expect(zones).toEqual(["europe-west2-b"]);
  });
});
