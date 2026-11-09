import { describe, expect, it } from "vitest";
import {
  ARM,
  armCall,
  armToken,
  buildDestroyPlan,
  buildSeedPlan,
  buildSubscriptionPlan,
  loadManifest,
  missingForApply,
  resolveConfig,
  runSeed,
  seedItems,
  shouldSkipApply,
} from "./seed.mjs";

const MAIN = "11111111-1111-1111-1111-111111111111";
const EMPTY = "22222222-2222-2222-2222-222222222222";
const NOW = "2026-11-09T12:00:00.000Z";
const FULL_ENV = {
  AZURE_SUBSCRIPTION_ID: MAIN,
  AZURE_EMPTY_SUBSCRIPTION_ID: EMPTY,
  AZURE_ACCESS_TOKEN: "test-token",
  AZURE_APP_REGISTRATION_TENANT_ID: "tenant-app",
  AZURE_BUDGET_CONTACT_EMAIL: "ops@example.test",
  AZURE_SEED_SSH_PUBLIC_KEY: "ssh-ed25519 AAAAtest",
  AZURE_SQL_ADMIN_LOGIN: "farside-sql-admins",
  AZURE_SQL_ADMIN_OBJECT_ID: "33333333-3333-3333-3333-333333333333",
};

function response(status, body = {}, headers = {}) {
  return {
    status,
    headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Fake ARM: records calls, answers GET subscription with a tenant, GET budgets with none. */
function fakeArm({ tenantId = "tenant-estate", emptyBudgets = [], failOn = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
    if (failOn && url.includes(failOn)) {
      return response(409, { error: { code: "Conflict" } });
    }
    if (init.method === "GET" && /\/subscriptions\/[^/]+\?/.test(url)) {
      return response(200, { tenantId });
    }
    if (init.method === "GET" && url.includes("Microsoft.Consumption/budgets?")) {
      return response(200, { value: emptyBudgets });
    }
    if (init.method === "POST") {
      return response(202, {}, { location: `${ARM}/operations/poll` });
    }
    if (url.includes("/operations/poll")) {
      return response(200, { status: "Succeeded" });
    }
    return response(init.method === "DELETE" ? 202 : 201, { properties: { provisioningState: "Succeeded" } });
  };
  return { calls, fetchImpl };
}

const noSleep = async () => {};
const noAz = () => {
  throw new Error("az not installed");
};

describe("azure estate seed plan", () => {
  const manifest = loadManifest();
  const config = resolveConfig(FULL_ENV);
  const plan = buildSeedPlan(manifest, config, { now: NOW });

  it("creates both resource groups first and the budget last", () => {
    expect(plan.operations[0].path).toBe(`/subscriptions/${MAIN}/resourceGroups/farside-test-seed`);
    expect(plan.operations[1].path).toBe(`/subscriptions/${EMPTY}/resourceGroups/farside-test-empty`);
    const last = plan.operations.at(-1);
    expect(last.path).toBe(`/subscriptions/${MAIN}/providers/Microsoft.Consumption/budgets/farside-test-guard`);
    expect(last.body.properties.notifications.actualOverThreshold.contactEmails).toEqual(["ops@example.test"]);
    expect(last.body.properties.timePeriod.startDate).toBe("2026-11-01T00:00:00.000Z");
  });

  it("maps every seeded item to an ARM operation or a manual step", () => {
    const covered = new Set([...plan.operations.map((op) => op.itemId), ...plan.manual.map((step) => step.itemId)]);
    for (const item of seedItems(manifest)) {
      expect(covered.has(item.id), item.id).toBe(true);
    }
  });

  it("puts nothing but a resource group in the empty no-budget subscription", () => {
    const empty = plan.operations.filter((op) => op.path.includes(EMPTY));
    expect(empty.map((op) => op.itemId)).toEqual(["rg-empty-no-budget"]);
  });

  it("keeps the unattached disk untagged and the stopped VM allocated", () => {
    const disk = plan.operations.find((op) => op.path.endsWith("/disks/fs-disk-unattached"));
    expect(disk.body.tags).toEqual({});
    const actions = plan.operations.filter((op) => op.method === "POST").map((op) => op.path.split("/").slice(-2).join("/"));
    expect(actions).toEqual(["fs-vm-stopped-allocated/powerOff", "fs-vm-deallocated/deallocate"]);
  });

  it("declares dependencies before dependants", () => {
    const index = (suffix) => plan.operations.findIndex((op) => op.path.endsWith(suffix));
    expect(index("/natGateways/fs-nat-attached")).toBeLessThan(index("/virtualNetworks/fs-vnet"));
    expect(index("/virtualNetworks/fs-vnet")).toBeLessThan(index("/networkInterfaces/fs-vm-deallocated-nic"));
    expect(index("/disks/fs-disk-attached")).toBeLessThan(index("/virtualMachines/fs-vm-deallocated"));
    expect(index("/vaults/fs-vault-main")).toBeLessThan(plan.operations.findIndex((op) => op.path.includes("protectedItems")));
  });

  it("uses SSH keys and Entra-only SQL, never passwords", () => {
    const text = JSON.stringify(plan.operations);
    expect(text).not.toMatch(/adminPassword|administratorLoginPassword/);
    expect(text).toContain('"azureADOnlyAuthentication":true');
  });

  it("lists certificates and wall-clock age as manual steps", () => {
    expect(plan.manual.map((step) => step.itemId)).toEqual(
      expect.arrayContaining(["snapshot-old", "cert-app-expiring", "cert-gateway-expiring"]),
    );
  });

  it("builds subscription aliases against a billing scope and a destroy plan", () => {
    const subs = buildSubscriptionPlan(resolveConfig({ AZURE_BILLING_SCOPE: "/providers/Microsoft.Billing/billingAccounts/x" }));
    expect(subs.operations.map((op) => op.path)).toEqual([
      "/providers/Microsoft.Subscription/aliases/farside-test-main",
      "/providers/Microsoft.Subscription/aliases/farside-test-empty",
    ]);
    expect(subs.operations[0].body.properties.billingScope).toContain("billingAccounts/x");
    const destroy = buildDestroyPlan(manifest, config);
    expect(destroy.operations.every((op) => op.method === "DELETE")).toBe(true);
    expect(destroy.operations.map((op) => op.itemId)).toEqual(["budget-main", "rg-main", "rg-empty-no-budget"]);
  });

  it("names missing apply config", () => {
    expect(missingForApply(config)).toEqual([]);
    const missing = missingForApply(resolveConfig({ AZURE_SUBSCRIPTION_ID: MAIN }));
    expect(missing.join(" ")).toMatch(/AZURE_EMPTY_SUBSCRIPTION_ID.*AZURE_APP_REGISTRATION_TENANT_ID.*AZURE_BUDGET_CONTACT_EMAIL/);
    expect(missingForApply(resolveConfig({}), { createSubscriptions: true })[0]).toMatch(/AZURE_BILLING_SCOPE/);
  });
});

describe("azure estate seed run", () => {
  it("is a dry run by default and calls nothing", async () => {
    const arm = fakeArm();
    const record = await runSeed({ env: FULL_ENV, fetchImpl: arm.fetchImpl, exec: noAz, now: NOW });
    expect(record).toMatchObject({ mode: "dry-run", applied: false, exitCode: 0 });
    expect(arm.calls).toEqual([]);
  });

  it("skips apply with exit 0 when the subscription id or token is absent", async () => {
    const arm = fakeArm();
    expect(shouldSkipApply({})).toBe(true);
    const noSub = await runSeed({ argv: ["--apply"], env: {}, fetchImpl: arm.fetchImpl, exec: noAz, now: NOW });
    expect(noSub).toMatchObject({ skipped: true, exitCode: 0 });
    expect(noSub.reason).toMatch(/AZURE_SUBSCRIPTION_ID/);
    const noToken = await runSeed({
      argv: ["--apply"],
      env: { ...FULL_ENV, AZURE_ACCESS_TOKEN: "" },
      fetchImpl: arm.fetchImpl,
      exec: noAz,
      now: NOW,
    });
    expect(noToken).toMatchObject({ skipped: true, exitCode: 0 });
    expect(noToken.reason).toMatch(/No ARM token/);
    expect(arm.calls).toEqual([]);
  });

  it("refuses apply with exit 2 when config is incomplete", async () => {
    const arm = fakeArm();
    const record = await runSeed({
      argv: ["--apply"],
      env: { AZURE_SUBSCRIPTION_ID: MAIN, AZURE_ACCESS_TOKEN: "t" },
      fetchImpl: arm.fetchImpl,
      exec: noAz,
      now: NOW,
    });
    expect(record.exitCode).toBe(2);
    expect(arm.calls).toEqual([]);
  });

  it("applies every operation with the bearer token", async () => {
    const arm = fakeArm();
    const record = await runSeed({ argv: ["--apply"], env: FULL_ENV, fetchImpl: arm.fetchImpl, exec: noAz, sleep: noSleep, now: NOW });
    expect(record).toMatchObject({ mode: "apply", applied: true, exitCode: 0 });
    const writes = arm.calls.filter((call) => call.method === "PUT" || call.method === "POST");
    expect(writes.length).toBe(record.operations.length);
    expect(arm.calls.every((call) => call.auth === "Bearer test-token")).toBe(true);
    expect(arm.calls.some((call) => call.url.endsWith("/operations/poll"))).toBe(true);
  });

  it("refuses an estate in the app-registration tenant", async () => {
    const arm = fakeArm({ tenantId: "tenant-app" });
    const record = await runSeed({ argv: ["--apply"], env: FULL_ENV, fetchImpl: arm.fetchImpl, exec: noAz, now: NOW });
    expect(record).toMatchObject({ applied: false, exitCode: 1 });
    expect(record.reason).toMatch(/app-registration tenant/);
    expect(arm.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("refuses when the empty subscription already has a budget", async () => {
    const arm = fakeArm({ emptyBudgets: [{ name: "stray" }] });
    const record = await runSeed({ argv: ["--apply"], env: FULL_ENV, fetchImpl: arm.fetchImpl, exec: noAz, now: NOW });
    expect(record.reason).toMatch(/must have none/);
    expect(record.exitCode).toBe(1);
  });

  it("stops at the first ARM failure and reports it", async () => {
    const arm = fakeArm({ failOn: "fs-pip-unassociated" });
    const record = await runSeed({ argv: ["--apply"], env: FULL_ENV, fetchImpl: arm.fetchImpl, exec: noAz, sleep: noSleep, now: NOW });
    expect(record.exitCode).toBe(1);
    expect(record.operations.at(-1).error).toMatch(/409/);
  });

  it("destroys resource groups and the budget only with --apply --destroy", async () => {
    const arm = fakeArm();
    const record = await runSeed({
      argv: ["--apply", "--destroy"],
      env: FULL_ENV,
      fetchImpl: arm.fetchImpl,
      exec: noAz,
      sleep: noSleep,
      now: NOW,
    });
    expect(record).toMatchObject({ action: "destroy", applied: true });
    expect(arm.calls.filter((call) => call.method === "DELETE").length).toBe(3);
  });

  it("creates subscription aliases only behind --create-subscriptions and a billing scope", async () => {
    const arm = fakeArm();
    const env = { AZURE_ACCESS_TOKEN: "t", AZURE_BILLING_SCOPE: "/providers/Microsoft.Billing/billingAccounts/x" };
    const record = await runSeed({
      argv: ["--apply", "--create-subscriptions"],
      env,
      fetchImpl: arm.fetchImpl,
      exec: noAz,
      sleep: noSleep,
      now: NOW,
    });
    expect(record).toMatchObject({ action: "create-subscriptions", applied: true });
    expect(arm.calls.map((call) => call.url.split("?")[0])).toEqual([
      `${ARM}/providers/Microsoft.Subscription/aliases/farside-test-main`,
      `${ARM}/providers/Microsoft.Subscription/aliases/farside-test-empty`,
    ]);
  });
});

describe("arm helpers", () => {
  it("reads a token from env, then az, else null", () => {
    expect(armToken({ AZURE_ACCESS_TOKEN: "env" }, noAz)).toBe("env");
    expect(armToken({}, () => "from-az\n")).toBe("from-az");
    expect(armToken({}, noAz)).toBeNull();
  });

  it("polls provisioningState until Succeeded", async () => {
    const states = ["Updating", "Succeeded"];
    const fetchImpl = async (_url, init) =>
      init.method === "PUT"
        ? response(201, { properties: { provisioningState: "Creating" } })
        : response(200, { properties: { provisioningState: states.shift() } });
    const result = await armCall({ method: "PUT", path: "/x", apiVersion: "1", body: {} }, { token: "t", fetchImpl, sleep: noSleep });
    expect(result.provisioningState).toBe("Succeeded");
  });

  it("throws when provisioning fails", async () => {
    const fetchImpl = async () => response(200, { properties: { provisioningState: "Failed" } });
    await expect(armCall({ method: "PUT", path: "/x", apiVersion: "1", body: {} }, { token: "t", fetchImpl, sleep: noSleep })).rejects.toThrow(
      /Failed/,
    );
  });
});
