import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAKE_CLIENT_ID,
  FAKE_HOME_TENANT_ID,
  FAKE_SUBSCRIPTIONS,
  FAKE_TENANT_ID,
  fakeAzure,
  fakeJwt,
  type FakeAzureOptions,
} from "../../backend/src/azure-fake.js";
import { secretPaths } from "../../backend/src/secrets.js";
import { liveRunRecords } from "../support-matrix/generate.mjs";
import { main as costPortal, compareTotals, untestedAgreementTypes, withinTolerance, type CostTotals } from "./cost-portal.js";
import { LIVE_RUNS_DIR, SKIP_MESSAGE, runEnvFromEnv, type RunIo } from "./lib.js";
import { main as runChecks } from "./run-checks.js";
import { main as verifyAccess } from "./verify-access.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const RUNNERS = { verifyAccess, runChecks, costPortal } as const;

function assertionFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "farside-assertion-")), "token");
  writeFileSync(path, fakeJwt({ iss: "https://sts.amazonaws.com", sub: "farside-runtime" }));
  return path;
}

function liveEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    FARSIDE_AZURE_LIVE: "1",
    FARSIDE_AZURE_CLIENT_ID: FAKE_CLIENT_ID,
    FARSIDE_AZURE_ASSERTION_FILE: assertionFile(),
    FARSIDE_AZURE_TENANT_ID: FAKE_TENANT_ID,
    FARSIDE_AZURE_SUBSCRIPTION_ID: FAKE_SUBSCRIPTIONS.main,
    FARSIDE_AZURE_EMPTY_SUBSCRIPTION_ID: FAKE_SUBSCRIPTIONS["empty-no-budget"],
    FARSIDE_AZURE_HOME_TENANT_ID: FAKE_HOME_TENANT_ID,
    FARSIDE_AZURE_AGREEMENT_TYPE: "payg",
    ...extra,
  };
}

function harness(env: Record<string, string>, fake: Partial<FakeAzureOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "azure-live-"));
  const lines: string[] = [];
  const azure = fakeAzure({ now: () => NOW, ...fake });
  const io: RunIo = {
    env,
    root,
    fetch: azure.fetch,
    now: () => NOW,
    stdout: { write: (chunk) => lines.push(chunk) },
    stderr: { write: (chunk) => lines.push(chunk) },
  };
  const record = <T = Record<string, unknown>>(kind: string) =>
    JSON.parse(readFileSync(join(root, LIVE_RUNS_DIR, `2026-11-02-${kind}.json`), "utf8")) as T;
  const written = () => (existsSync(join(root, LIVE_RUNS_DIR)) ? readdirSync(join(root, LIVE_RUNS_DIR)).sort() : []);
  return { root, io, azure, lines, record, written };
}

describe("live runners without credentials", () => {
  for (const [name, run] of Object.entries(RUNNERS)) {
    it(`${name} exits 0, says it skipped, and writes nothing`, async () => {
      const { io, lines, written, azure } = harness({});
      expect(await run([], io)).toBe(0);
      expect(lines.join("")).toContain(SKIP_MESSAGE);
      expect(written()).toEqual([]);
      expect(azure.calls).toEqual([]);
    });
  }

  it("treats a partial configuration as no credentials and names what is missing", () => {
    const { runEnv, missing } = runEnvFromEnv({ FARSIDE_AZURE_LIVE: "1", FARSIDE_AZURE_CLIENT_ID: FAKE_CLIENT_ID });
    expect(runEnv).toBeNull();
    expect(missing).toEqual(["an assertion file (FARSIDE_AZURE_ASSERTION_FILE)", "FARSIDE_AZURE_TENANT_ID", "FARSIDE_AZURE_SUBSCRIPTION_ID"]);
  });

  it("refuses to run with a client secret in the environment", async () => {
    const { io, written } = harness(liveEnv({ AZURE_CLIENT_SECRET: "nope" }));
    expect(await verifyAccess([], io)).toBe(1);
    expect(written()).toEqual([]);
  });
});

describe("roles-and-queries and cross-tenant proof (#41, #42)", () => {
  it("records the federated exchange, the roles, and every query by alias only", async () => {
    const { io, record, azure } = harness(liveEnv());
    expect(await verifyAccess([], io)).toBe(0);
    const access = record<{
      federated: Record<string, unknown>;
      roles: { granted: string[]; missing: unknown[] };
      queries: Array<{ name: string; outcome: string }>;
    }>("access");
    expect(access.federated).toMatchObject({ secretless: true, exchanged: true, tokenTenantMatches: true, crossTenant: true, error: null });
    expect(access.roles.missing).toEqual([]);
    expect(access.queries.filter((query) => query.outcome !== "ok").map((query) => [query.name, query.outcome])).toEqual([
      ["reservations and savings plans", "not-built"],
    ]);
    const text = JSON.stringify(access);
    for (const id of [FAKE_TENANT_ID, ...Object.values(FAKE_SUBSCRIPTIONS), azure.accessToken]) {
      expect(text).not.toContain(id);
    }
    expect(secretPaths(access)).toEqual([]);
  });

  it("records a refused exchange and exits 1", async () => {
    const { io, record } = harness(liveEnv(), { fail: { token: 400 } });
    expect(await verifyAccess([], io)).toBe(1);
    expect(record<{ federated: Record<string, unknown> }>("access").federated).toMatchObject({ exchanged: false, error: "HTTP 400 AADSTS700016" });
  });

  it("does not claim cross-tenant without the home tenant, and records denied roles", async () => {
    const env = liveEnv();
    delete env.FARSIDE_AZURE_HOME_TENANT_ID;
    const { io, record } = harness(env, { roles: ["Reader"], fail: { cost: 403 } });
    expect(await verifyAccess([], io)).toBe(0);
    const access = record<{ federated: Record<string, unknown>; queries: Array<{ name: string; outcome: string }>; roles: { missing: Array<{ role: string }> } }>("access");
    expect(access.federated.crossTenant).toBeNull();
    expect(access.roles.missing.map((gap) => gap.role)).toContain("Cost Management Reader");
    expect(access.queries.find((query) => query.name === "cost management query")?.outcome).toBe("denied");
  });
});

describe("live checks vs ground truth (#122, #123, #154, #155, #63)", () => {
  it("writes non-cost, cost and inventory records that the support matrix can read", async () => {
    const { io, record, written } = harness(liveEnv());
    expect(await runChecks([], io)).toBe(0);
    expect(written()).toEqual(["2026-11-02-checks-cost.json", "2026-11-02-checks-noncost.json", "2026-11-02-inventory.json"]);
    type Checks = { checks: Array<{ checkId: string; result: string; defects: string[] }>; skipped: Array<{ checkId: string }>; scans: Array<{ subscription: string; status: string }> };
    const noncost = record<Checks>("checks-noncost");
    expect(noncost.scans.map((scan) => [scan.subscription, scan.status])).toEqual([
      ["main", "succeeded"],
      ["empty-no-budget", "succeeded"],
    ]);
    expect(noncost.checks.filter((check) => check.result === "fail").map((check) => check.checkId)).toEqual(["azure-lifecycle-expiring-gateway-certs"]);
    expect(noncost.checks).toHaveLength(15);
    const cost = record<Checks>("checks-cost");
    expect(cost.checks).toEqual([{ checkId: "azure-cost-subscriptions-without-budgets", result: "pass", defects: [] }]);
    expect(cost.skipped.map((item) => item.checkId)).toHaveLength(4);
    expect(record<{ result: string; missing: string[] }>("inventory")).toMatchObject({ result: "pass", missing: [], unexpected: [] });
    const flattened = liveRunRecords("2026-11-02-checks-noncost.json", noncost);
    expect(flattened.every((row: { liveRunAt: string }) => row.liveRunAt === "2026-11-02")).toBe(true);
    const all = written().map((name) => readFileSync(join(io.root ?? "", LIVE_RUNS_DIR, name), "utf8")).join("");
    for (const id of [FAKE_TENANT_ID, ...Object.values(FAKE_SUBSCRIPTIONS)]) {
      expect(all).not.toContain(id);
    }
  });

  it("skips empty-subscription cases when that subscription is not configured", async () => {
    const env = liveEnv();
    delete env.FARSIDE_AZURE_EMPTY_SUBSCRIPTION_ID;
    const { io, record } = harness(env);
    expect(await runChecks([], io)).toBe(0);
    const noncost = record<{ skipped: Array<{ checkId: string; reason: string }> }>("checks-noncost");
    expect(noncost.skipped).toEqual([{ checkId: "azure-inventory-all-resources", reason: "subscription 'empty-no-budget' was not part of the run" }]);
  });

  it("exits 1 and records failed checks when the scan fails", async () => {
    const { io, record } = harness(liveEnv(), { fail: { graph: 500 } });
    expect(await runChecks([], io)).toBe(1);
    const noncost = record<{ scans: Array<{ status: string }>; checks: Array<{ result: string }> }>("checks-noncost");
    expect(noncost.scans[0]?.status).toBe("failed");
    expect(noncost.checks.every((check) => check.result === "fail")).toBe(true);
  });
});

describe("cost totals vs portal (#131)", () => {
  it("writes harvested totals with empty portal values and the untested agreement types", async () => {
    const { io, record } = harness(liveEnv());
    expect(await costPortal([], io)).toBe(0);
    const totals = record<CostTotals>("cost-totals");
    expect(totals).toMatchObject({ currency: "USD", agreementType: "payg", billingScope: "/subscriptions/main" });
    expect(totals.months.length).toBeGreaterThanOrEqual(2);
    expect(totals.months.every((row) => row.portal === null)).toBe(true);
    expect(totals.untestedAgreementTypes).toEqual(["Microsoft Customer Agreement", "Enterprise Agreement", "Cloud Solution Provider"]);
    expect("checks" in totals).toBe(false);
  });

  it("compares filled portal values offline and records spend and month-on-month results", async () => {
    const { io, record, root } = harness(liveEnv());
    await costPortal([], io);
    const totals = record<CostTotals>("cost-totals");
    const path = join(root, LIVE_RUNS_DIR, "2026-11-02-cost-totals.json");
    const fill = (portal: (harvested: string) => string) =>
      writeFileSync(
        path,
        JSON.stringify({
          ...totals,
          months: totals.months.map((row) => ({ ...row, portal: portal(row.harvested) })),
          services: totals.services.map((row) => ({ ...row, portal: portal(row.harvested) })),
        }),
      );
    fill((value) => value);
    const offline = { ...io, env: {} };
    expect(await costPortal(["--compare", path], offline)).toBe(0);
    expect(record<{ matched: boolean; checks: Array<{ result: string }> }>("cost-portal")).toMatchObject({
      matched: true,
      checks: [
        { checkId: "azure-cost-spend-by-service", result: "pass" },
        { checkId: "azure-cost-month-on-month", result: "pass" },
      ],
    });
    fill((value) => (Number(value) * 1.1).toFixed(2));
    expect(await costPortal(["--compare", path], offline)).toBe(1);
    expect(record<{ matched: boolean }>("cost-portal").matched).toBe(false);
  });

  it("needs every portal value and two months, within half a percent", () => {
    expect(withinTolerance("100.00", "100.40")).toBe(true);
    expect(withinTolerance("100.00", "101.00")).toBe(false);
    expect(withinTolerance("0.00", "0.01")).toBe(true);
    expect(untestedAgreementTypes(null)).toHaveLength(4);
    const totals = { months: [{ month: "2026-10", harvested: "1.00", portal: null }], services: [], tolerancePercent: 0.5 } as unknown as CostTotals;
    expect(compareTotals(totals).problems).toEqual(["month 2026-10: portal value missing or not a decimal", "month-on-month needs two complete months"]);
  });
});
