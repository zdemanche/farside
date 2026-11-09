import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import spec from "../../docs/gcp/launch-checks.json" with { type: "json" };
import type { GcpPermissionTester } from "./gcp-live.js";
import "./providers/index.js";
import {
  ROLE_PERMISSIONS,
  ROLE_RUN_KIND,
  UNNAMED_PERMISSIONS,
  gcpPermissionRoleLister,
  main,
  verifyGcpRoles,
} from "./gcp-role-verify.js";
import { secretPaths } from "./secrets.js";

const NOW = () => new Date("2026-12-01T09:00:00.000Z");
const TABLE = "farside-billing.billing_export.gcp_billing_export_v1_0000";

function tester(denied: readonly string[] = []): GcpPermissionTester & { calls: string[][] } {
  const calls: string[][] = [];
  const grant = async (_scope: string, permissions: readonly string[]) => {
    calls.push([...permissions]);
    return permissions.filter((permission) => !denied.includes(permission));
  };
  return { calls, project: grant, table: grant };
}

describe("GCP role verifier", () => {
  it("has a permission map for exactly the spec role list", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...spec.rolesFromProposal].sort());
  });

  it("verifies every role when every permission is granted", async () => {
    const record = await verifyGcpRoles({
      projectId: "farside-test",
      tester: tester(),
      billingTable: TABLE,
      now: NOW,
    });
    expect(record).toMatchObject({
      kind: ROLE_RUN_KIND,
      liveRunAt: "2026-12-01",
      healthy: true,
      missingRequiredRoles: [],
    });
    expect(record.roles.every((role) => role.verified)).toBe(true);
    expect(record.unnamedPermissions).toEqual([
      expect.objectContaining({ permission: "container.clusters.list", granted: true }),
    ]);
    expect(secretPaths(record)).toEqual([]);
  });

  it("reports a role missing when one of its permissions is denied, and flags the connection", async () => {
    const record = await verifyGcpRoles({
      projectId: "farside-test",
      tester: tester(["cloudsql.instances.list"]),
      billingTable: TABLE,
      now: NOW,
    });
    const sql = record.roles.find((role) => role.role === "Cloud SQL Viewer");
    expect(sql).toMatchObject({ verified: false, missing: ["cloudsql.instances.list"] });
    expect(record.healthy).toBe(false);
    expect(record.missingRequiredRoles).toEqual(["Cloud SQL Viewer"]);
  });

  it("does not claim the billing role without a table to test, and stays healthy because it is optional", async () => {
    const record = await verifyGcpRoles({ projectId: "farside-test", tester: tester(), now: NOW });
    const billing = record.roles.find(
      (role) => role.role === "BigQuery access to the billing export",
    );
    expect(billing).toMatchObject({ verified: false, missing: ["bigquery.tables.getData"] });
    expect(billing?.note).toContain("not configured");
    expect(record.healthy).toBe(true);
  });

  it("lists GKE read access as a permission no spec role names", () => {
    expect(UNNAMED_PERMISSIONS.map((item) => item.permission)).toEqual(["container.clusters.list"]);
  });

  it("backs the connect RoleLister", async () => {
    const roles = await gcpPermissionRoleLister(tester(["compute.disks.list"]), TABLE).list({
      tenantId: "",
      subscriptionId: "farside-test",
      cloud: "gcp",
    });
    expect(roles).not.toContain("Compute Viewer");
    expect(roles).toContain("Cloud Asset Viewer");
  });

  it("skips cleanly without credentials", async () => {
    const out = vi.fn();
    expect(await main({ env: {}, out })).toBe(0);
    expect(out).toHaveBeenCalledWith("skipped: no GCP credentials");
  });

  it("writes a dated record from a mocked GCP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gcp-roles-"));
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://sts.googleapis.com/")) {
        return Response.json({ access_token: "federated" });
      }
      if (url.startsWith("https://iamcredentials.googleapis.com/")) {
        return Response.json({ accessToken: "impersonated", expireTime: "2026-12-01T10:00:00Z" });
      }
      return Response.json({ permissions: JSON.parse(String(init.body)).permissions });
    });
    const out = vi.fn();
    const code = await main({
      env: {
        FARSIDE_GCP_LIVE: "1",
        FARSIDE_GCP_PROJECT_ID: "farside-test",
        FARSIDE_GCP_POOL_PROJECT_NUMBER: "123456789",
        FARSIDE_GCP_POOL_ID: "farside-pool",
        FARSIDE_GCP_PROVIDER_ID: "farside-aws",
        FARSIDE_GCP_SERVICE_ACCOUNT: "farside-reader@farside-test.iam.gserviceaccount.com",
        FARSIDE_GCP_SUBJECT_TOKEN_FILE: "/run/oidc",
        FARSIDE_GCP_BILLING_EXPORT_TABLE: TABLE,
      },
      deps: { fetch, readFile: async () => "oidc", now: NOW },
      out,
      dir,
    });
    expect(code).toBe(0);
    expect(readdirSync(dir)).toEqual(["2026-12-01-farside-test-roles.json"]);
    const text = readFileSync(join(dir, "2026-12-01-farside-test-roles.json"), "utf8");
    expect(JSON.parse(text).roles.every((role: { verified: boolean }) => role.verified)).toBe(true);
    expect(text).not.toContain("impersonated");
  });
});
