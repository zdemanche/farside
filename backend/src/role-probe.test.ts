import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { checksForRole } from "./cli-credentials.js";
import { grantedRoleLister, mutableRoleLister, presentRoles, probeRoles } from "./role-probe.js";
import { REQUIRED_AZURE_ROLES } from "./roles.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { TEST_APP_OPTIONS } from "./test-clock.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("role probe", () => {
  it("stores blocked checks for each removed role and stays healthy when only optional roles are missing", () => {
    const withoutCost = probeRoles("azure", ["Reader", "Monitoring Reader", "Reservations Reader", "Backup Reader"]);
    expect(withoutCost.healthy).toBe(false);
    expect(withoutCost.missingRoles).toEqual([
      {
        role: "Cost Management Reader",
        required: true,
        blockedCheckIds: checksForRole("azure", "Cost Management Reader"),
      },
    ]);
    expect(withoutCost.missingRoles[0]?.blockedCheckIds).toEqual(
      expect.arrayContaining(["azure-cost-spend-by-service", "azure-cost-subscriptions-without-budgets"]),
    );

    const withoutBackup = probeRoles("azure", [...REQUIRED_AZURE_ROLES]);
    expect(withoutBackup.healthy).toBe(true);
    expect(withoutBackup.missingRoles).toEqual([
      {
        role: "Backup Reader",
        required: false,
        blockedCheckIds: checksForRole("azure", "Backup Reader"),
      },
    ]);
  });
});

describe("connect stores role gaps", () => {
  const store = new MemoryStore();
  const app = buildApp(store, {
    ...TEST_APP_OPTIONS,
    roleLister: grantedRoleLister(["Reader", "Monitoring Reader", "Reservations Reader"]),
  });

  afterAll(() => app.close());

  it("records missing roles on the connection when the lister omits them", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      healthy: boolean;
      roles: string[];
      missingRoles: Array<{ role: string; required: boolean; blockedCheckIds: string[] }>;
    };
    expect(body.healthy).toBe(false);
    expect(body.roles).toEqual(["Reader", "Monitoring Reader", "Reservations Reader"]);
    expect(body.missingRoles.map((gap) => gap.role).sort()).toEqual(["Backup Reader", "Cost Management Reader"]);
    expect(body.missingRoles.find((gap) => gap.role === "Cost Management Reader")).toMatchObject({
      required: true,
      blockedCheckIds: expect.arrayContaining(["azure-cost-spend-by-service"]),
    });
    expect((await store.read("org-a", "connections")).connections[0]?.missingRoles).toEqual(body.missingRoles);
  });
});

describe("disconnect and revoked grants", () => {
  const store = new MemoryStore();
  const lister = mutableRoleLister(presentRoles("azure"));
  const app = buildApp(store, { ...TEST_APP_OPTIONS, roleLister: lister });

  afterAll(() => app.close());

  it("marks the connection broken when the grant is revoked and removes it on disconnect", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-revoke/connections",
      headers: { [ORG_HEADER]: "org-revoke", [ACTOR_HEADER]: "actor-revoke" },
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().healthy).toBe(true);
    const id = created.json().id as string;

    lister.grant(["Cost Management Reader"]);
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/orgs/org-revoke/connections/${id}/roles`,
      headers: { [ORG_HEADER]: "org-revoke", [ACTOR_HEADER]: "actor-revoke" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      id,
      healthy: false,
      roles: ["Cost Management Reader"],
    });
    expect(revoked.json().missingRoles.map((gap: { role: string }) => gap.role)).toEqual(
      expect.arrayContaining(["Reader", "Monitoring Reader", "Reservations Reader"]),
    );
    expect((await store.read("org-revoke", "connections")).connections[0]?.healthy).toBe(false);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/orgs/org-revoke/connections/${id}`,
      headers: { [ORG_HEADER]: "org-revoke", [ACTOR_HEADER]: "actor-revoke" },
    });
    expect(removed.statusCode).toBe(204);
    expect((await store.read("org-revoke", "connections")).connections).toEqual([]);
  });
});
