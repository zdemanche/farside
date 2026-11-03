import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Finding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import { cloudFromCheckId, parseCloudQuery } from "./cloud.js";
import { recordCoverageScope } from "./coverage.js";
import { inventoryFromGcpManifest, type GcpGroundTruthManifest } from "./gcp-inventory.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { applyScanToIssues } from "./issues.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";

const AZURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;
const GCP = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/gcp/ground-truth.json"), "utf8"),
) as GcpGroundTruthManifest;
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

const azureFail: Finding = {
  checkId: "azure-waste-unattached-disks",
  result: "fail",
  evidence: { fields: { diskId: "disk-unattached", diskState: "Unattached" } },
  scope: { id: "main:azure-waste-unattached-disks", cloud: "azure", subscriptionOrProject: "main" },
  savings: { min: "8.00", max: "12.00", currency: "USD" },
};

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

describe("cloud helpers", () => {
  it("reads azure or gcp from a query and rejects anything else", () => {
    expect(parseCloudQuery({})).toEqual({});
    expect(parseCloudQuery({ cloud: "gcp" })).toEqual({ cloud: "gcp" });
    expect(parseCloudQuery({ cloud: "aws" }).error).toMatch(/azure or gcp/);
    expect(cloudFromCheckId("gcp-waste-unattached-disks")).toBe("gcp");
    expect(cloudFromCheckId("azure-waste-unattached-disks")).toBe("azure");
  });
});

describe("cloud dimension on APIs", () => {
  const store = new MemoryStore();
  const app = buildApp(store);

  afterAll(async () => {
    await app.close();
  });

  it("keeps both inventories and filters list APIs by cloud", async () => {
    const azure = inventoryFromManifest(AZURE);
    const gcp = inventoryFromGcpManifest(GCP);
    expect((await app.inject({ method: "PUT", url: "/v1/orgs/org-a/inventory", headers: ORG, payload: azure })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/v1/orgs/org-a/inventory", headers: ORG, payload: gcp })).statusCode).toBe(200);

    const latest = await app.inject({ method: "GET", url: "/v1/orgs/org-a/inventory", headers: ORG });
    expect(latest.json().cloud).toBe("gcp");
    const azureGet = await app.inject({ method: "GET", url: "/v1/orgs/org-a/inventory?cloud=azure", headers: ORG });
    expect(azureGet.json().cloud).toBe("azure");
    expect(azureGet.json().resources).toHaveLength(azure.resources.length);
    const gcpGet = await app.inject({ method: "GET", url: "/v1/orgs/org-a/inventory?cloud=gcp", headers: ORG });
    expect(gcpGet.json().cloud).toBe("gcp");
    expect(gcpGet.json().resources).toHaveLength(gcp.resources.length);

    const bad = await app.inject({ method: "GET", url: "/v1/orgs/org-a/issues?cloud=aws", headers: ORG });
    expect(bad.statusCode).toBe(400);

    store.putCoverage("org-a", [
      recordCoverageScope({
        subscriptionOrProject: "main",
        checkId: "azure-waste-unattached-disks",
        state: "assessed",
      }),
      recordCoverageScope({
        subscriptionOrProject: "farside-test",
        checkId: "gcp-waste-unattached-disks",
        state: "assessed",
      }),
    ]);
    store.putFindings("org-a", [azureFail, gcpFail]);
    store.putIssues(
      "org-a",
      applyScanToIssues({
        issues: [],
        findings: [azureFail, gcpFail],
        coverage: store.snapshot("org-a").coverage,
        scanId: "scan-seed",
        observedAt: "1970-01-01T00:00:00.000Z",
      }),
    );
    store.putJob({
      orgId: "org-a",
      subscriptionId: "main",
      cloud: "azure",
      actor: "user",
      status: "succeeded",
      complete: true,
      coveredScopes: ["main:azure-waste-unattached-disks"],
      createdAt: "1970-01-01T00:00:00.000Z",
      startedAt: "1970-01-01T00:00:00.000Z",
      finishedAt: "1970-01-01T00:00:00.001Z",
      error: null,
      durationMs: 1,
      coverageSummary: { assessed: 1, unassessed: 0, undetermined: 0 },
      checks: [{ checkId: "azure-waste-unattached-disks", state: "assessed" }],
    });
    store.putJob({
      orgId: "org-a",
      subscriptionId: "farside-test",
      cloud: "gcp",
      actor: "user",
      status: "succeeded",
      complete: true,
      coveredScopes: ["farside-test:gcp-waste-unattached-disks"],
      createdAt: "1970-01-01T00:00:00.000Z",
      startedAt: "1970-01-01T00:00:00.000Z",
      finishedAt: "1970-01-01T00:00:00.001Z",
      error: null,
      durationMs: 1,
      coverageSummary: { assessed: 1, unassessed: 0, undetermined: 0 },
      checks: [{ checkId: "gcp-waste-unattached-disks", state: "assessed" }],
    });

    const issues = await app.inject({ method: "GET", url: "/v1/orgs/org-a/issues", headers: ORG });
    expect(issues.json().issues).toHaveLength(2);
    const gcpIssues = await app.inject({ method: "GET", url: "/v1/orgs/org-a/issues?cloud=gcp", headers: ORG });
    expect(gcpIssues.json().issues).toHaveLength(1);
    expect(gcpIssues.json().issues[0].cloud).toBe("gcp");
    expect(gcpIssues.json().issues[0].resourceId).toBe("disk-parked");

    const findings = await app.inject({ method: "GET", url: "/v1/orgs/org-a/findings?cloud=azure", headers: ORG });
    expect(findings.json().findings).toHaveLength(1);
    expect(findings.json().findings[0].scope.cloud).toBe("azure");

    const scans = await app.inject({ method: "GET", url: "/v1/orgs/org-a/scans?cloud=gcp", headers: ORG });
    expect(scans.json().scans).toHaveLength(1);
    expect(scans.json().scans[0].cloud).toBe("gcp");

    const coverage = await app.inject({ method: "GET", url: "/v1/orgs/org-a/coverage?cloud=gcp", headers: ORG });
    expect(coverage.json().entries).toHaveLength(1);
    expect(coverage.json().entries[0].cloud).toBe("gcp");

    const waste = await app.inject({ method: "GET", url: "/v1/orgs/org-a/cost-waste?cloud=gcp", headers: ORG });
    expect(waste.json().waste).toHaveLength(1);
    expect(waste.json().waste[0].cloud).toBe("gcp");

    const browse = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/inventory/browse?cloud=gcp",
      headers: ORG,
    });
    expect(browse.json().total).toBe(gcp.resources.length);
    expect(browse.json().resources.every((row: { cloud: string }) => row.cloud === "gcp")).toBe(true);

    const estate = await app.inject({ method: "GET", url: "/v1/orgs/org-a/estate?cloud=azure", headers: ORG });
    expect(estate.json().empty).toBe(false);
    expect(estate.json().resourceTotal).toBe(azure.resources.length);

    const exported = await app.inject({ method: "GET", url: "/v1/orgs/org-a/export/issues?cloud=gcp", headers: ORG });
    expect(exported.json().rows).toHaveLength(1);
    expect(exported.json().rows[0].cloud).toBe("gcp");
  });
});
