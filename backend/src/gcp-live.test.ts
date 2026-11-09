import { describe, expect, it, vi } from "vitest";
import { CloudAssetThrottleError, harvestCloudAssets } from "./cloud-asset.js";
import { detectBillingExport } from "./gcp-billing-export.js";
import {
  MissingBillingExportRoleError,
  harvestGcpCost,
  readAllBigQueryExportPages,
} from "./gcp-cost.js";
import {
  GcpAccessDeniedError,
  GcpApiError,
  GcpAuthError,
  MAX_ATTEMPTS,
  MissingRecommenderRoleError,
  billingExportQuery,
  gcpJson,
  gcpProperties,
  gkeMinorVersion,
  liveBigQueryExportClient,
  liveBillingExportDetector,
  liveCloudAssetClient,
  liveGcpPermissionTester,
  liveRecommenderClient,
  liveServiceReads,
  type FetchLike,
} from "./gcp-live.js";
import { REC_TYPE, checkGcpIdleRecommendations } from "./gcp-recommender.js";

const NOW = () => new Date("2026-12-01T00:00:00.000Z");
const token = async () => "tok";
const sleep = async () => undefined;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const TABLE = "farside-billing.billing_export.gcp_billing_export_v1_0000";

function mock(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn<FetchLike>(async (url, init) => handler(url, init));
}

describe("GCP REST transport", () => {
  it("refuses non-GCP URLs before asking for the token", async () => {
    const tokenSpy = vi.fn(token);
    await expect(
      gcpJson({ token: tokenSpy, fetch: mock(() => json({})) }, "GET", "https://evil.example/x"),
    ).rejects.toThrow("refusing");
    expect(tokenSpy).not.toHaveBeenCalled();
  });

  it("maps 401 and 403 separately and retries throttling", async () => {
    await expect(
      gcpJson(
        { token, fetch: mock(() => json({}, 401)) },
        "GET",
        "https://cloudasset.googleapis.com/v1/x",
      ),
    ).rejects.toBeInstanceOf(GcpAuthError);
    await expect(
      gcpJson(
        { token, fetch: mock(() => json({}, 403)) },
        "GET",
        "https://cloudasset.googleapis.com/v1/x",
      ),
    ).rejects.toBeInstanceOf(GcpAccessDeniedError);
    let calls = 0;
    const fetch = mock(() => (++calls < MAX_ATTEMPTS ? json({}, 429) : json({ ok: true })));
    expect(
      await gcpJson({ token, fetch, sleep }, "GET", "https://cloudasset.googleapis.com/v1/x"),
    ).toEqual({ ok: true });
    await expect(
      gcpJson(
        { token, fetch: mock(() => json({}, 500)) },
        "GET",
        "https://cloudasset.googleapis.com/v1/x",
      ),
    ).rejects.toBeInstanceOf(GcpApiError);
  });
});

describe("Cloud Asset live client", () => {
  const disk = (name: string, data: Record<string, unknown>) => ({
    name: `//compute.googleapis.com/projects/farside-test/zones/us-central1-a/disks/${name}`,
    assetType: "compute.googleapis.com/Disk",
    resource: { location: "us-central1-a", data },
  });

  it("pages with pageToken and maps RESOURCE data onto check facts", async () => {
    const fetch = mock((url) => {
      const params = new URL(url).searchParams;
      expect(params.get("contentType")).toBe("RESOURCE");
      if (params.get("assetTypes") !== "compute.googleapis.com/Disk") {
        return json({});
      }
      return params.get("pageToken") === "p2"
        ? json({
            assets: [
              disk("disk-in-use", {
                sizeGb: "50",
                users: ["vm"],
                labels: { owner: "farside-test" },
              }),
            ],
          })
        : json({ assets: [disk("disk-parked", { sizeGb: "100" })], nextPageToken: "p2" });
    });
    const harvest = await harvestCloudAssets({
      client: liveCloudAssetClient({ token, fetch, now: NOW }),
      projectId: "farside-test",
    });
    expect(harvest.ok).toBe(true);
    expect(
      harvest.assets.map((asset) => [
        asset.id,
        asset.properties?.usersCount,
        asset.properties?.sizeGb,
      ]),
    ).toEqual([
      ["disk-parked", 0, 100],
      ["disk-in-use", 1, 50],
    ]);
    expect(
      harvest.inventory.resources.find((resource) => resource.displayName === "disk-parked")
        ?.ownerTag,
    ).toBeNull();
    // Recommendations are not a Cloud Asset type, so none of the calls asks for them.
    expect(
      fetch.mock.calls.some((call) => String(call[0]).includes(encodeURIComponent(REC_TYPE))),
    ).toBe(false);
  });

  it("turns final throttling into the throttling cause", async () => {
    const harvest = await harvestCloudAssets({
      client: liveCloudAssetClient({ token, fetch: mock(() => json({}, 429)), sleep }),
      projectId: "farside-test",
    });
    expect(harvest).toMatchObject({ ok: false, reason: "throttling" });
    await expect(
      liveCloudAssetClient({ token, fetch: mock(() => json({}, 429)), sleep }).list({
        projectId: "farside-test",
        assetType: "compute.googleapis.com/Disk",
      }),
    ).rejects.toBeInstanceOf(CloudAssetThrottleError);
  });

  it("rejects a malformed project id", async () => {
    await expect(
      liveCloudAssetClient({ token, fetch: mock(() => json({})) }).list({
        projectId: "../x",
        assetType: "compute.googleapis.com/Disk",
      }),
    ).rejects.toThrow();
  });
});

describe("resource property mapping", () => {
  it("covers snapshots, images, SQL, GKE and certificates", () => {
    const now = NOW();
    expect(
      gcpProperties(
        "compute.googleapis.com/Snapshot",
        { creationTimestamp: "2026-09-01T00:00:00Z", storageBytes: String(3 * 2 ** 30) },
        now,
      ),
    ).toEqual({
      creationTimestamp: "2026-09-01T00:00:00Z",
      ageDays: 91,
      sizeGb: 3,
    });
    expect(gcpProperties("compute.googleapis.com/Image", { diskSizeGb: "10" }, now)).toMatchObject({
      ageDays: null,
      sizeGb: 10,
    });
    expect(
      gcpProperties(
        "compute.googleapis.com/Address",
        { status: "RESERVED", address: "203.0.113.10" },
        now,
      ),
    ).toMatchObject({ status: "RESERVED", usersCount: 0 });
    expect(
      gcpProperties(
        "sqladmin.googleapis.com/Instance",
        {
          databaseVersion: "MYSQL_8_0",
          settings: { availabilityType: "ZONAL", backupConfiguration: { enabled: true } },
        },
        now,
      ),
    ).toEqual({ databaseVersion: "MYSQL_8_0", availabilityType: "ZONAL", backupEnabled: true });
    expect(gcpProperties("sqladmin.googleapis.com/Instance", { settings: {} }, now)).toMatchObject({
      availabilityType: null,
      backupEnabled: null,
    });
    expect(
      gcpProperties(
        "container.googleapis.com/Cluster",
        { currentMasterVersion: "1.30.5-gke.1014001" },
        now,
      ),
    ).toEqual({ currentMasterVersion: "1.30" });
    expect(
      gcpProperties(
        "certificatemanager.googleapis.com/Certificate",
        { expireTime: "2026-12-31T00:00:00Z" },
        now,
      ),
    ).toEqual({
      expireTime: "2026-12-31T00:00:00Z",
      daysRemaining: 30,
    });
    expect(gkeMinorVersion(null)).toBeNull();
  });
});

describe("direct service reads", () => {
  it("lists SQL instances, GKE clusters and certificates with labels", async () => {
    const fetch = mock((url) => {
      if (url.startsWith("https://sqladmin.googleapis.com/")) {
        return url.includes("pageToken=n")
          ? json({
              items: [
                {
                  name: "sql-zonal",
                  region: "us-central1",
                  databaseVersion: "MYSQL_8_0",
                  settings: {
                    availabilityType: "ZONAL",
                    backupConfiguration: { enabled: true },
                    userLabels: { owner: "o" },
                  },
                },
              ],
            })
          : json({ items: [], nextPageToken: "n" });
      }
      if (url.startsWith("https://container.googleapis.com/")) {
        expect(url).toContain("/locations/-/clusters");
        return json({
          clusters: [
            {
              name: "gke-current",
              location: "us-central1",
              currentMasterVersion: "1.31.1-gke.1",
              resourceLabels: { owner: "o" },
            },
          ],
        });
      }
      return json({
        certificates: [
          {
            name: "projects/farside-test/locations/global/certificates/cert-expiring",
            expireTime: "2026-12-20T00:00:00Z",
            labels: { owner: "o" },
          },
        ],
      });
    });
    const reads = liveServiceReads({ token, fetch, now: NOW });
    const [sql] = await reads.listSqlInstances("farside-test");
    expect(sql).toMatchObject({
      id: "sql-zonal",
      location: "us-central1",
      labels: { owner: "o" },
      properties: { availabilityType: "ZONAL" },
    });
    const [gke] = await reads.listGkeClusters("farside-test");
    expect(gke).toMatchObject({ id: "gke-current", properties: { currentMasterVersion: "1.31" } });
    const [cert] = await reads.listCertificates("farside-test");
    expect(cert).toMatchObject({
      id: "cert-expiring",
      location: "global",
      properties: { daysRemaining: 19 },
    });
  });
});

describe("Recommender live client", () => {
  const rec = {
    name: "projects/123/locations/us-central1-a/recommenders/google.compute.instance.IdleResourceRecommender/recommendations/abc",
    recommenderSubtype: "STOP_VM",
    stateInfo: { state: "ACTIVE" },
    primaryImpact: {
      costProjection: { cost: { currencyCode: "USD", units: "-20", nanos: -500000000 } },
    },
    content: {
      operationGroups: [
        {
          operations: [
            {
              resource:
                "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/instances/vm-parked",
            },
          ],
        },
      ],
    },
  };

  it("maps active recommendations and keeps the point cost as savingsMax only", async () => {
    const fetch = mock(() =>
      json({
        recommendations: [
          rec,
          { ...rec, name: `${rec.name}-old`, stateInfo: { state: "DISMISSED" } },
        ],
      }),
    );
    const rows = await liveRecommenderClient({ token, fetch }).list({
      projectId: "farside-test",
      location: "us-central1-a",
      recommenderId: "google.compute.instance.IdleResourceRecommender",
    });
    expect(rows).toEqual([
      {
        recommendationId: "abc",
        recommenderId: "google.compute.instance.IdleResourceRecommender",
        resourceName:
          "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/instances/vm-parked",
        subtype: "STOP_VM",
        projectId: "farside-test",
        savingsMax: 20.5,
        currency: "USD",
      },
    ]);
    // A point projection is not a range: the check stays undetermined instead of inventing a min.
    const out = checkGcpIdleRecommendations("farside-test", { ok: true, recommendations: rows });
    expect(out.findings[0]?.result).toBe("undetermined");
  });

  it("maps a refused list to the missing Recommender role", async () => {
    await expect(
      liveRecommenderClient({ token, fetch: mock(() => json({}, 403)) }).list({
        projectId: "farside-test",
        location: "us-central1-a",
        recommenderId: "google.compute.disk.IdleResourceRecommender",
      }),
    ).rejects.toBeInstanceOf(MissingRecommenderRoleError);
  });
});

describe("BigQuery billing export live client", () => {
  const row = (date: string, service: string, cost: string) => ({
    f: [{ v: date }, { v: "farside-test" }, { v: service }, { v: cost }, { v: "USD" }],
  });

  it("runs one parameterised query, polls until complete and pages through results", async () => {
    const fetch = mock((url, init) => {
      if (init.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.query).toBe(billingExportQuery(TABLE));
        expect(body.queryParameters[0]).toEqual({
          name: "projectId",
          parameterType: { type: "STRING" },
          parameterValue: { value: "farside-test" },
        });
        return json({ jobComplete: false, jobReference: { jobId: "job_1", location: "US" } });
      }
      const params = new URL(url).searchParams;
      expect(url).toContain("/queries/job_1?");
      return params.get("pageToken") === "p2"
        ? json({ jobComplete: true, rows: [row("2026-11-02", "Compute Engine", "4.00")] })
        : json({
            jobComplete: true,
            rows: [row("2026-11-01", "Compute Engine", "2.50")],
            pageToken: "p2",
          });
    });
    const client = liveBigQueryExportClient({
      token,
      fetch,
      sleep,
      table: TABLE,
      jobProjectId: "farside-test",
    });
    const rows = await readAllBigQueryExportPages(client, "farside-test");
    expect(rows.map((item) => item.costAmount)).toEqual(["2.50", "4.00"]);
    const harvest = await harvestGcpCost({
      client: liveBigQueryExportClient({
        token,
        fetch,
        sleep,
        table: TABLE,
        jobProjectId: "farside-test",
      }),
      projectId: "farside-test",
    });
    expect(harvest.ok && harvest.snapshot.services[0]).toMatchObject({
      serviceName: "Compute Engine",
      costAmount: "6.50",
    });
  });

  it("maps 403 to the missing billing export role and refuses malformed amounts", async () => {
    const denied = liveBigQueryExportClient({
      token,
      fetch: mock(() => json({}, 403)),
      table: TABLE,
      jobProjectId: "farside-test",
    });
    await expect(denied.query({ projectId: "farside-test" })).rejects.toBeInstanceOf(
      MissingBillingExportRoleError,
    );
    const bad = liveBigQueryExportClient({
      token,
      fetch: mock(() =>
        json({
          jobComplete: true,
          jobReference: { jobId: "j", location: "US" },
          rows: [row("2026-11-01", "x", "NaN")],
        }),
      ),
      table: TABLE,
      jobProjectId: "farside-test",
    });
    await expect(bad.query({ projectId: "farside-test" })).rejects.toBeInstanceOf(GcpApiError);
  });

  it("rejects a table name that could break out of the query", () => {
    expect(() => billingExportQuery("p.d.t` WHERE 1=1 --")).toThrow();
  });
});

describe("billing export detector", () => {
  it("reports absent, unreadable, empty and readable states", async () => {
    const detect = (handler: Parameters<typeof mock>[0]) =>
      liveBillingExportDetector({
        token,
        fetch: mock(handler),
        table: TABLE,
        jobProjectId: "farside-test",
      }).detect();
    expect(await detect(() => json({}, 404))).toEqual({ state: "absent" });
    expect(await detect(() => json({}, 403))).toEqual({ state: "unreadable" });
    const created = String(Date.parse("2026-11-20T00:00:00Z"));
    const meta = (rows: unknown[]) => (_url: string, init: RequestInit) =>
      init.method === "GET"
        ? json({ creationTime: created })
        : json({ jobComplete: true, jobReference: { jobId: "j", location: "US" }, rows });
    const empty = await detect(meta([]));
    expect(detectBillingExport(empty)).toMatchObject({
      state: "empty",
      startDate: "2026-11-20",
      historyDays: 0,
    });
    const readable = await detect(
      meta([{ f: [{ v: "2026-11-20" }] }, { f: [{ v: "2026-11-21" }] }]),
    );
    expect(detectBillingExport(readable)).toMatchObject({ state: "readable", historyDays: 2 });
  });
});

describe("permission tester", () => {
  it("returns the granted subset from project and table testIamPermissions", async () => {
    const fetch = mock((url, init) => {
      const asked = JSON.parse(String(init.body)).permissions as string[];
      if (
        url.startsWith(
          "https://cloudresourcemanager.googleapis.com/v1/projects/farside-test:testIamPermissions",
        )
      ) {
        return json({ permissions: asked.slice(0, 1) });
      }
      return json({}, 403);
    });
    const tester = liveGcpPermissionTester({ token, fetch });
    expect(await tester.project("farside-test", ["a.b.c", "d.e.f"])).toEqual(["a.b.c"]);
    expect(await tester.table(TABLE, ["bigquery.tables.getData"])).toEqual([]);
  });
});
