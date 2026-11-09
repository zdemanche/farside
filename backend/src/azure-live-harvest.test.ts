import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Inventory } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import {
  FAKE_CLIENT_ID,
  FAKE_SUBSCRIPTIONS,
  FAKE_TENANT_ID,
  fakeAzure,
  fakeJwt,
  type FakeAzureOptions,
} from "./azure-fake.js";
import {
  AzureLiveConfigError,
  azureLiveConfigFromEnv,
  azureLiveFromEnv,
  azureLiveWiring,
} from "./azure-live-harvest.js";
import { diffCheck, type ManifestWithChecks } from "./ground-truth-diff.js";
import { DEMO_ORG_ID } from "./demo.js";
import { fixtureHarvester, ScanRunner, unconfiguredHarvester, type ScanJob } from "./scans.js";
import { scheduledRunner } from "./scheduled.js";
import { ScanScheduler } from "./scheduler.js";
import { secretPaths } from "./secrets.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };

const NOW = "2026-11-02T12:00:00.000Z";
const clock = () => NOW;
const MANIFEST = docAzureGroundTruth as unknown as ManifestWithChecks;
const ASSERTION = fakeJwt({ iss: "https://sts.amazonaws.com", sub: "farside-runtime" });
const ORG = "org-live";

function assertionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "farside-assertion-"));
  const path = join(dir, "token");
  writeFileSync(path, ASSERTION);
  return path;
}

const liveEnv = (path: string) => ({ FARSIDE_AZURE_LIVE: "1", FARSIDE_AZURE_CLIENT_ID: FAKE_CLIENT_ID, AWS_WEB_IDENTITY_TOKEN_FILE: path });

async function connected(store: MemoryStore, subscriptions = Object.values(FAKE_SUBSCRIPTIONS)) {
  for (const subscriptionId of subscriptions) {
    await store.putConnection(ORG, { tenantId: FAKE_TENANT_ID, subscriptionId, cloud: "azure" });
  }
}

function liveRunner(store: MemoryStore, options: Partial<FakeAzureOptions> = {}) {
  const azure = fakeAzure({ now: () => new Date(NOW), ...options });
  const wiring = azureLiveWiring(
    { clientId: FAKE_CLIENT_ID, assertion: async () => ASSERTION },
    { store, fallback: unconfiguredHarvester(), fetch: azure.fetch, clock },
  );
  return { azure, wiring, runner: new ScanRunner(store, wiring.harvester, wiring.harvestClients, clock) };
}

async function scanAll(store: MemoryStore, runner: ScanRunner): Promise<ScanJob[]> {
  const jobs: ScanJob[] = [];
  for (const subscriptionId of Object.values(FAKE_SUBSCRIPTIONS)) {
    jobs.push(await (await runner.start({ orgId: ORG, subscriptionId, actor: "system" })).done);
  }
  return jobs;
}

async function output(store: MemoryStore) {
  const org = await store.read(ORG, "findings", "coverage", "inventories");
  return { findings: org.findings, coverage: org.coverage, inventory: org.inventories.azure as Inventory };
}

describe("live Azure config", () => {
  it("is off unless FARSIDE_AZURE_LIVE=1, so CI and the default path need no credentials", () => {
    expect(azureLiveConfigFromEnv({})).toBeNull();
    expect(azureLiveConfigFromEnv({ FARSIDE_AZURE_LIVE: "0", FARSIDE_AZURE_CLIENT_ID: FAKE_CLIENT_ID })).toBeNull();
    expect(azureLiveFromEnv({}, { store: new MemoryStore(), fallback: unconfiguredHarvester() })).toBeNull();
  });

  it("fails fast when switched on but incomplete, naming what is missing", () => {
    expect(() => azureLiveConfigFromEnv({ FARSIDE_AZURE_LIVE: "1" })).toThrow(
      /FARSIDE_AZURE_CLIENT_ID.*FARSIDE_AZURE_ASSERTION_FILE or AZURE_FEDERATED_TOKEN_FILE or AWS_WEB_IDENTITY_TOKEN_FILE/,
    );
  });

  it("refuses a client secret even with everything else set", () => {
    expect(() => azureLiveConfigFromEnv({ ...liveEnv("/t"), AZURE_CLIENT_SECRET: "x" })).toThrow(AzureLiveConfigError);
  });

  it("returns the client id and assertion file when complete", () => {
    expect(azureLiveConfigFromEnv(liveEnv("/run/token"))).toEqual({ clientId: FAKE_CLIENT_ID, assertionFile: "/run/token" });
  });
});

describe("live Azure harvest", () => {
  it("scans both seeded subscriptions and agrees with the ground truth except gateway cert expiry", async () => {
    const store = new MemoryStore(clock);
    await connected(store);
    const { runner } = liveRunner(store);
    const jobs = await scanAll(store, runner);
    expect(jobs.map((job) => [job.status, job.complete, job.actor])).toEqual([
      ["succeeded", true, "system"],
      ["succeeded", true, "system"],
    ]);
    const scan = await output(store);
    const diffs = MANIFEST.checks.map((check) => diffCheck(check, MANIFEST, scan, FAKE_SUBSCRIPTIONS));
    const failed = diffs.filter((diff) => "result" in diff && diff.result === "fail");
    // ARM has no expiry on an Application Gateway certificate; that check stays undetermined live.
    expect(failed.map((diff) => diff.checkId)).toEqual(["azure-lifecycle-expiring-gateway-certs"]);
    expect(diffs.filter((diff) => "skipped" in diff).map((diff) => diff.checkId)).toEqual([
      "azure-cost-spend-by-service",
      "azure-cost-month-on-month",
      "azure-cost-reservation-use",
      "azure-cost-savings-plan-use",
    ]);
    const { costs } = await store.read(ORG, "costs");
    expect(costs[FAKE_SUBSCRIPTIONS.main]?.currency).toBe("USD");
  });

  it("never stores or returns the access token", async () => {
    const store = new MemoryStore(clock);
    await connected(store);
    const { azure, runner } = liveRunner(store);
    await scanAll(store, runner);
    const everything = await store.read(ORG, "findings", "coverage", "inventories", "facts", "scans", "costs", "budgets", "connections");
    expect(JSON.stringify(everything)).not.toContain(azure.accessToken);
    expect(JSON.stringify(everything)).not.toContain(ASSERTION);
    expect(secretPaths(everything)).toEqual([]);
  });

  it("exchanges once per tenant and reuses the cached token across scans", async () => {
    const store = new MemoryStore(clock);
    await connected(store);
    const { azure, runner } = liveRunner(store);
    await scanAll(store, runner);
    expect(azure.tokensIssued()).toBe(1);
  });

  it("keeps a missing Monitoring Reader or Backup Reader as undetermined, not pass", async () => {
    const store = new MemoryStore(clock);
    await connected(store, [FAKE_SUBSCRIPTIONS.main]);
    const { runner } = liveRunner(store, { fail: { metrics: 403, backup: 403 } });
    const job = await (await runner.start({ orgId: ORG, subscriptionId: FAKE_SUBSCRIPTIONS.main, actor: "system" })).done;
    expect(job.status).toBe("succeeded");
    const { findings } = await output(store);
    const results = (checkId: string) => new Set(findings.filter((finding) => finding.checkId === checkId).map((finding) => finding.result));
    expect(results("azure-waste-idle-load-balancers")).toEqual(new Set(["undetermined"]));
    expect([...results("azure-resilience-prod-vms-outside-backup")]).not.toContain("fail");
  });

  it("fails the scan, not complete, when Resource Graph fails", async () => {
    const store = new MemoryStore(clock);
    await connected(store, [FAKE_SUBSCRIPTIONS.main]);
    const { runner } = liveRunner(store, { fail: { graph: 500 } });
    const job = await (await runner.start({ orgId: ORG, subscriptionId: FAKE_SUBSCRIPTIONS.main, actor: "system" })).done;
    expect([job.status, job.complete, job.error]).toEqual(["failed", false, "harvest_failed"]);
  });

  it("fails the scan when Entra refuses the federated exchange, without leaking the assertion", async () => {
    const store = new MemoryStore(clock);
    await connected(store, [FAKE_SUBSCRIPTIONS.main]);
    const { runner } = liveRunner(store, { fail: { token: 401 } });
    const job = await (await runner.start({ orgId: ORG, subscriptionId: FAKE_SUBSCRIPTIONS.main, actor: "system" })).done;
    expect(job.status).toBe("failed");
    expect(JSON.stringify(job)).not.toContain(ASSERTION);
  });

  it("hands subscriptions without an Azure connection to the fallback harvester", async () => {
    const store = new MemoryStore(clock);
    const azure = fakeAzure({ now: () => new Date(NOW) });
    const fallback = fixtureHarvester({ cloud: "azure", observedAt: NOW, resources: [] });
    const wiring = azureLiveWiring({ clientId: FAKE_CLIENT_ID, assertion: async () => ASSERTION }, { store, fallback, fetch: azure.fetch, clock });
    const job = await (await new ScanRunner(store, wiring.harvester, wiring.harvestClients, clock).start({ orgId: ORG, subscriptionId: "main", actor: "user" })).done;
    expect(job.status).toBe("succeeded");
    expect(azure.calls).toEqual([]);
  });
});

describe("unattended scheduler path", () => {
  it("runs a system scan through the live harvester from the environment alone", async () => {
    const store = new MemoryStore(clock);
    await connected(store, [FAKE_SUBSCRIPTIONS.main]);
    const azure = fakeAzure({ now: () => new Date(NOW) });
    const runner = scheduledRunner(store, { env: liveEnv(assertionFile()), clock, fetch: azure.fetch });
    const tick = await new ScanScheduler(store, runner, clock).tick(ORG, NOW);
    expect(tick.action).toBe("started");
    expect(tick.scans[0]?.scan.actor).toBe("system");
    const scanId = tick.scans[0]?.scan.id ?? "";
    await vi.waitFor(async () => expect((await store.getJob(ORG, scanId))?.status).toBe("succeeded"), {
      timeout: 5_000,
      interval: 10,
    });
    expect(azure.tokensIssued()).toBe(1);
  });

  it("stays on the unconfigured harvester without live config", async () => {
    const store = new MemoryStore(clock);
    await connected(store, [FAKE_SUBSCRIPTIONS.main]);
    const runner = scheduledRunner(store, { env: {}, clock });
    const job = await (await runner.start({ orgId: ORG, subscriptionId: FAKE_SUBSCRIPTIONS.main, actor: "system" })).done;
    expect([job.status, job.error]).toEqual(["failed", "No cloud provider is configured"]);
  });
});

describe("live wiring in the API", () => {
  it("lists the service principal's roles on connect and blocks the demo org", async () => {
    const store = new MemoryStore(clock);
    const { wiring, azure } = liveRunner(store);
    const app = buildApp(store, {
      clock,
      harvester: wiring.harvester,
      harvestClients: wiring.harvestClients,
      roleLister: wiring.roleLister,
    });
    const response = await app.inject({
      method: "PUT",
      url: `/v1/orgs/${ORG}/connections`,
      headers: { [ORG_HEADER]: ORG, [ACTOR_HEADER]: "cto" },
      payload: { tenantId: FAKE_TENANT_ID, subscriptionId: FAKE_SUBSCRIPTIONS.main },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ healthy: true, missingRoles: [] });
    expect(response.body).not.toContain(azure.accessToken);
    const before = azure.calls.length;
    const demo = await (await app.inject({ method: "GET", url: `/v1/orgs/${DEMO_ORG_ID}/connections`, headers: { [ORG_HEADER]: DEMO_ORG_ID, [ACTOR_HEADER]: "cto" } }));
    expect(demo.statusCode).toBeLessThan(500);
    expect(azure.calls.length).toBe(before);
    await app.close();
  });
});
