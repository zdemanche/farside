import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import specJson from "../../docs/gcp/launch-checks.json" with { type: "json" };
import manifestJson from "../../docs/gcp/ground-truth.json" with { type: "json" };
import { fixtureAssetsFromManifest, fixtureCloudAssetClient } from "./cloud-asset.js";
import { fixtureBigQueryExportClient } from "./gcp-cost.js";
import type { GcpGroundTruthItem, GcpGroundTruthManifest } from "./gcp-inventory.js";
import { liveGcpHarvester } from "./gcp-live-harvester.js";
import type { GcpServiceReads, RecommenderClient } from "./gcp-live.js";
import {
  INVENTORY_NO_OWNER,
  applyRecordToSpec,
  applyRecordToSpecText,
  diffCases,
  expectedFromManifest,
  main,
  runGcpLiveChecks,
} from "./gcp-live-run.js";
import { gcpProvider } from "./providers/gcp.js";
import { secretPaths } from "./secrets.js";

const manifest = manifestJson as GcpGroundTruthManifest;
const NOW = () => new Date("2026-12-01T09:00:00.000Z");
const PROJECT = "farside-test";

const noReads: GcpServiceReads = {
  listSqlInstances: async () => [],
  listGkeClusters: async () => [],
  listCertificates: async () => [],
};

/** A "live" project that looks exactly like the seed (gke-stale is unseedable, so absent). */
function seededClients(options?: {
  drop?: string[];
  extra?: GcpGroundTruthItem[];
  recommender?: RecommenderClient;
}) {
  const items = manifest.items
    .filter((item) => item.type !== "recommender.googleapis.com/Recommendation")
    .filter((item) => item.id !== "gke-stale" && !(options?.drop ?? []).includes(item.id));
  const recs = manifest.items.filter(
    (item) => item.type === "recommender.googleapis.com/Recommendation",
  );
  const recommender: RecommenderClient = options?.recommender ?? {
    async list(input) {
      return recs
        .filter(
          (item) =>
            item.properties?.recommenderId === input.recommenderId &&
            item.region === input.location,
        )
        .map((item) => ({
          recommendationId: `live-${item.id}`,
          recommenderId: String(item.properties?.recommenderId),
          resourceName: String(item.properties?.resourceName),
          subtype: String(item.properties?.subtype),
          projectId: PROJECT,
          savingsMin: Number(item.properties?.savingsMin),
          savingsMax: Number(item.properties?.savingsMax),
          currency: "USD",
        }));
    },
  };
  return {
    cloudAsset: fixtureCloudAssetClient({ items: [...items, ...(options?.extra ?? [])] }),
    serviceReads: noReads,
    recommender,
  };
}

describe("expected cases from the manifest", () => {
  it("cover every diffed launch check and drop unseedable cases", () => {
    const expected = expectedFromManifest();
    expect(expected.get("gcp-waste-unattached-disks")?.get("disk-parked")).toBe("fail");
    expect(expected.get("gcp-waste-unattached-disks")?.get("disk-in-use")).toBe("pass");
    expect(expected.get("gcp-waste-idle-vm-and-disk-recommendations")?.get("vm-parked")).toBe(
      "fail",
    );
    expect(expected.get("gcp-lifecycle-sql-gke-support")?.get("sql-stale")).toBe("fail");
    expect(expected.get("gcp-lifecycle-sql-gke-support")?.has("gke-stale")).toBe(false);
    expect(expected.get(INVENTORY_NO_OWNER)?.get("disk-parked")).toBe("fail");
    expect(expected.has("gcp-cost-committed-use")).toBe(false);
  });
});

describe("diff", () => {
  it("fails on missing, mismatched and unexpected failures but allows extra passes", () => {
    const expected = new Map([
      ["a", "fail" as const],
      ["b", "pass" as const],
      ["c", "pass" as const],
    ]);
    const live = new Map([
      ["a", "fail" as const],
      ["b", "fail" as const],
      ["boot", "pass" as const],
      ["rogue", "fail" as const],
      ["gke-node-1", "fail" as const],
    ]);
    const run = diffCases("x", expected, live);
    expect(run).toMatchObject({
      result: "fail",
      matched: 1,
      missing: ["c"],
      mismatched: [{ key: "b", expected: "pass", live: "fail" }],
      unexpected: ["rogue"],
    });
  });
});

describe("live check run", () => {
  it("passes every diffed check when the project matches the seed", async () => {
    const record = await runGcpLiveChecks({
      projectId: PROJECT,
      harvester: liveGcpHarvester(seededClients(), () => NOW().toISOString()),
      costClient: fixtureBigQueryExportClient(),
      now: NOW,
    });
    expect(record.liveRunAt).toBe("2026-12-01");
    expect(record.error).toBeNull();
    const byId = new Map(record.checks.map((check) => [check.checkId, check]));
    expect([...byId.keys()].sort()).toEqual([...gcpProvider.launchCheckIds].sort());
    for (const id of gcpProvider.launchCheckIds) {
      const check = byId.get(id);
      if (id === "gcp-cost-committed-use" || id === "gcp-cost-spend-by-service") {
        expect(check?.result).toBe("not-run");
      } else {
        expect({ id, result: check?.result, check }).toMatchObject({ id, result: "pass" });
      }
    }
    expect(byId.get("gcp-cost-spend-by-service")?.summary?.serviceCount).toBeGreaterThan(0);
    expect(secretPaths(record)).toEqual([]);
  });

  it("records a missing seeded resource and a false positive", async () => {
    const rogue = {
      ...(manifest.items.find((item) => item.id === "disk-parked") as GcpGroundTruthItem),
      id: "disk-rogue",
    };
    const record = await runGcpLiveChecks({
      projectId: PROJECT,
      harvester: liveGcpHarvester(seededClients({ drop: ["addr-idle"], extra: [rogue] })),
      now: NOW,
    });
    const ips = record.checks.find((check) => check.checkId === "gcp-waste-unused-external-ips");
    expect(ips).toMatchObject({ result: "fail", missing: ["addr-idle"] });
    const disks = record.checks.find((check) => check.checkId === "gcp-waste-unattached-disks");
    expect(disks).toMatchObject({ result: "fail", unexpected: ["disk-rogue"] });
    expect(
      record.checks.find((check) => check.checkId === "gcp-cost-spend-by-service")?.reason,
    ).toContain("FARSIDE_GCP_BILLING_EXPORT_TABLE");
  });

  it("fails the Recommender check on a missing role instead of calling it clean", async () => {
    const recommender: RecommenderClient = {
      async list() {
        const { MissingRecommenderRoleError } = await import("./gcp-live.js");
        throw new MissingRecommenderRoleError();
      },
    };
    const record = await runGcpLiveChecks({
      projectId: PROJECT,
      harvester: liveGcpHarvester(seededClients({ recommender })),
      now: NOW,
    });
    const recs = record.checks.find(
      (check) => check.checkId === "gcp-waste-idle-vm-and-disk-recommendations",
    );
    expect(recs?.result).toBe("fail");
    expect(recs?.reason).toContain("missing_role");
  });

  it("writes only the error name when the harvest throws", async () => {
    const record = await runGcpLiveChecks({
      projectId: PROJECT,
      harvester: {
        async harvest() {
          const error = new Error("Bearer ya29.leakedleakedleakedleaked");
          error.name = "GcpAuthError";
          throw error;
        },
      },
      now: NOW,
    });
    expect(record.error).toBe("GcpAuthError");
    expect(record.checks.every((check) => check.result === "not-run")).toBe(true);
    expect(JSON.stringify(record)).not.toContain("ya29");
  });
});

describe("spec update", () => {
  const record = {
    liveRunAt: "2026-12-01",
    checks: [
      {
        checkId: "gcp-waste-unattached-disks",
        result: "pass" as const,
        expected: 2,
        matched: 2,
        missing: [],
        mismatched: [],
        unexpected: [],
      },
      {
        checkId: "gcp-waste-unused-external-ips",
        result: "fail" as const,
        expected: 2,
        matched: 1,
        missing: ["addr-idle"],
        mismatched: [],
        unexpected: [],
      },
    ],
  };

  it("marks only passing checks verified with the run date", () => {
    const next = applyRecordToSpec(specJson, record);
    const disks = next.checks.find((check) => check.id === "gcp-waste-unattached-disks");
    const ips = next.checks.find((check) => check.id === "gcp-waste-unused-external-ips");
    expect(disks).toMatchObject({
      status: "verified",
      support: "supported",
      liveRunAt: "2026-12-01",
    });
    expect(ips).toMatchObject({ status: "unverified", support: "not-supported", liveRunAt: null });
  });

  it("keeps the spec file layout when editing in place", () => {
    const text = readFileSync(
      new URL("../../docs/gcp/launch-checks.json", import.meta.url),
      "utf8",
    );
    const next = applyRecordToSpecText(text, record);
    const changed = next.split("\n").filter((line, index) => line !== text.split("\n")[index]);
    expect(changed).toEqual([
      '      "status": "verified",',
      '      "support": "supported",',
      '      "liveRunAt": "2026-12-01"',
    ]);
  });
});

describe("live runner main", () => {
  it("skips cleanly without credentials", async () => {
    const out = vi.fn();
    expect(await main({ env: {}, out })).toBe(0);
    expect(out).toHaveBeenCalledWith("skipped: no GCP credentials");
  });

  it("refuses a half-configured live switch", async () => {
    const out = vi.fn();
    expect(await main({ env: { FARSIDE_GCP_LIVE: "1" }, out })).toBe(1);
    expect(String(out.mock.calls[0]?.[0])).toContain("FARSIDE_GCP_PROJECT_ID");
  });

  it("writes a dated record, updates the spec and regenerates the matrix with a mocked GCP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gcp-live-"));
    const specPath = join(dir, "launch-checks.json");
    writeFileSync(
      specPath,
      readFileSync(new URL("../../docs/gcp/launch-checks.json", import.meta.url), "utf8"),
    );
    const assets = fixtureAssetsFromManifest(manifest).filter(
      (asset) => asset.id !== "gke-stale" && !asset.assetType.startsWith("recommender"),
    );
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith("https://sts.googleapis.com/")) {
        return Response.json({ access_token: "federated" });
      }
      if (url.startsWith("https://iamcredentials.googleapis.com/")) {
        return Response.json({ accessToken: "impersonated", expireTime: "2026-12-01T10:00:00Z" });
      }
      if (url.startsWith("https://cloudasset.googleapis.com/")) {
        const type = new URL(url).searchParams.get("assetTypes");
        return Response.json({
          assets: assets
            .filter((asset) => asset.assetType === type)
            .map((asset) => ({
              name: asset.name,
              assetType: asset.assetType,
              resource: { location: asset.location, data: { labels: asset.labels } },
            })),
        });
      }
      return Response.json({});
    });
    const regenerate = vi.fn();
    const out = vi.fn();
    const code = await main({
      env: {
        FARSIDE_GCP_LIVE: "1",
        FARSIDE_GCP_PROJECT_ID: PROJECT,
        FARSIDE_GCP_POOL_PROJECT_NUMBER: "123456789",
        FARSIDE_GCP_POOL_ID: "farside-pool",
        FARSIDE_GCP_PROVIDER_ID: "farside-aws",
        FARSIDE_GCP_SERVICE_ACCOUNT: "farside-reader@farside-test.iam.gserviceaccount.com",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
      },
      deps: { fetch, readFile: async () => "oidc", now: NOW },
      out,
      dir,
      specPath,
      regenerate,
    });
    // Mocked bodies carry no properties, so waste checks are undetermined: the run must say fail.
    expect(code).toBe(1);
    expect(regenerate).toHaveBeenCalledOnce();
    const files = readdirSync(dir).filter((name) => name.startsWith("2026-"));
    expect(files).toEqual(["2026-12-01-farside-test-checks.json"]);
    const written = JSON.parse(readFileSync(join(dir, files[0] as string), "utf8"));
    expect(written.connection.subjectSource).toBe("oidc-file");
    expect(JSON.stringify(written)).not.toContain("impersonated");
    const inventory = written.checks.find(
      (check: { checkId: string }) => check.checkId === "gcp-inventory-all-assets",
    );
    expect(inventory.result).toBe("pass");
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    expect(
      spec.checks.find((check: { id: string }) => check.id === "gcp-inventory-all-assets")
        .liveRunAt,
    ).toBe("2026-12-01");
  });
});
