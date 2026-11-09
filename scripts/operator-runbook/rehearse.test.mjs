import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../backend/src/app.ts";
import { inventoryFromManifest } from "../../backend/src/inventory.ts";
import { fixtureHarvester } from "../../backend/src/scans.ts";
import { MemoryStore } from "../../backend/src/store.ts";
import { REQUIRED_STEPS } from "./lint.mjs";
import { MANUAL_STEPS, parseArgs, preconditions, rehearse, runbookTitles } from "./rehearse.mjs";

const NOW = "2026-11-09T12:00:00.000Z";
const outDir = () => mkdtempSync(join(tmpdir(), "farside-rehearsal-"));
const noSleep = async () => {};
const apps = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop().close();
});

/** fetch over Fastify inject: the live path talks to the real routes, no network. */
function injectFetch(app) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    const response = await app.inject({
      method: init.method,
      url: path,
      headers: init.headers,
      ...(init.body ? { payload: init.body } : {}),
    });
    return { status: response.statusCode, json: async () => response.json() };
  };
}

function liveApp() {
  const manifest = JSON.parse(readFileSync(new URL("../../docs/azure/ground-truth.json", import.meta.url), "utf8"));
  const store = new MemoryStore(() => NOW);
  const app = buildApp(store, {
    clock: () => NOW,
    operatorToken: "op-token",
    harvester: fixtureHarvester(inventoryFromManifest(manifest)),
  });
  apps.push(app);
  return app;
}

describe("rehearsal dry run", () => {
  it("walks every runbook step in order and writes a dated record", async () => {
    const dir = outDir();
    const { record, file, exitCode } = await rehearse({ argv: ["--out-dir", dir], env: {}, now: NOW });
    expect(exitCode).toBe(0);
    expect(record.steps.map((step) => step.id)).toEqual(REQUIRED_STEPS);
    expect(record.mode).toBe("dry-run");
    expect(record.note).toMatch(/No live call was made/);
    expect(record.result).toBe("incomplete");
    expect(file).toBe(join(dir, "2026-11-09-example-customer-dry-run.json"));
    expect(readdirSync(dir)).toEqual(["2026-11-09-example-customer-dry-run.json"]);
    for (const step of record.steps) {
      expect(step.status).toBe(MANUAL_STEPS.has(step.id) ? "manual" : "ready");
    }
  });

  it("blocks a step whose precondition fails and exits 1", async () => {
    const { record, exitCode } = await rehearse({
      argv: ["--customer", "example-customer", "--account", "999999999999", "--no-write"],
      env: {},
      now: NOW,
    });
    expect(exitCode).toBe(1);
    expect(record.steps.find((step) => step.id === "create-account").status).toBe("blocked");
    expect(record.result).toBe("fail");
  });

  it("refuses a connect tenant equal to the app-registration tenant", () => {
    const problems = preconditions({
      customer: "example-customer",
      account: "000000000001",
      org: "o",
      tenant: "t-app",
      subscription: "s",
      appTenant: "t-app",
      now: NOW,
    });
    expect(problems["connect-azure"].join(" ")).toMatch(/app-registration tenant/);
  });

  it("reads step titles from the runbook", () => {
    const titles = runbookTitles(readFileSync(new URL("../../docs/operator-runbook.md", import.meta.url), "utf8"));
    expect(titles["first-scan"]).toBe("10. First scan");
  });

  it("parses flags", () => {
    expect(parseArgs(["--live", "--confirmed", "deploy-base,claim-org"])).toMatchObject({
      live: true,
      confirmed: ["deploy-base", "claim-org"],
    });
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown/);
  });
});

describe("rehearsal live mode", () => {
  it("skips cleanly with exit 0 when the API URL or operator token is absent", async () => {
    const calls = [];
    const { record, exitCode } = await rehearse({
      argv: ["--live", "--no-write"],
      env: {},
      fetchImpl: async (...args) => calls.push(args),
      now: NOW,
    });
    expect(exitCode).toBe(0);
    expect(record.mode).toBe("live-skipped");
    expect(calls).toEqual([]);
  });

  it("stops at the first unconfirmed manual step", async () => {
    const app = liveApp();
    const { record } = await rehearse({
      argv: ["--live", "--no-write", "--org", "org-r", "--subscription", "main"],
      env: { FARSIDE_API_URL: "http://farside.test", FARSIDE_OPERATOR_TOKEN: "op-token" },
      fetchImpl: injectFetch(app),
      sleep: noSleep,
      now: NOW,
    });
    expect(record.steps.map((step) => step.status).slice(0, 3)).toEqual(["passed", "manual", "not-reached"]);
    expect(record.result).toBe("incomplete");
  });

  it("drives contract, connect and first scan against the real routes once external steps are confirmed", async () => {
    const app = liveApp();
    const dir = outDir();
    const { record, exitCode } = await rehearse({
      argv: [
        "--live",
        "--out-dir",
        dir,
        "--org",
        "org-r",
        "--subscription",
        "main",
        "--tenant",
        "tenant-customer",
        "--confirmed",
        "register-product,create-account,deploy-base,deploy-identity,deploy-launch,claim-org",
      ],
      env: { FARSIDE_API_URL: "http://farside.test", FARSIDE_OPERATOR_TOKEN: "op-token" },
      fetchImpl: injectFetch(app),
      sleep: async () => new Promise((resolve) => setImmediate(resolve)),
      now: NOW,
    });
    const status = Object.fromEntries(record.steps.map((step) => [step.id, step.status]));
    expect(status["record-contract"]).toBe("passed");
    expect(status["connect-azure"]).toBe("passed");
    expect(status["first-scan"]).toBe("passed");
    expect(status["deploy-farside"]).toBe("unchecked");
    expect(status["claim-org"]).toBe("operator-confirmed");
    expect(record.result).toBe("incomplete");
    expect(exitCode).toBe(0);
  });

  it("fails the contract step on a wrong operator token", async () => {
    const app = liveApp();
    const { record, exitCode } = await rehearse({
      argv: ["--live", "--no-write", "--org", "org-r"],
      env: { FARSIDE_API_URL: "http://farside.test", FARSIDE_OPERATOR_TOKEN: "wrong" },
      fetchImpl: injectFetch(app),
      now: NOW,
    });
    expect(record.steps[0]).toMatchObject({ id: "record-contract", status: "failed" });
    expect(record.steps[0].detail).toMatch(/403/);
    expect(exitCode).toBe(1);
  });
});
