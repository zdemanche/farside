import { afterEach, describe, expect, it } from "vitest";
import type { Inventory } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import { runChecks } from "./checks.js";
import { defineCheck, fail, indexFacts, num, pass, str, undetermined } from "./checks/define.js";
import { coverageFromHarvest } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import { providerFor, registerProvider, registeredCheckIds } from "./providers/index.js";
import { fixtureHarvester } from "./providers/fixture-harvester.js";
import type { CloudProvider, PostHarvest } from "./providers/types.js";
import { ScanRunner } from "./scans.js";
import { scopeOf } from "./scope.js";
import { MemoryStore } from "./store.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const REAL_GCP = providerFor("gcp");
const FAKE_CHECK_ID = "gcp-fake-things";
const FAKE_SAVINGS = { min: "1.00", max: "2.00", currency: "USD", basis: "fake basis" };
const fakeScope = (resourceUri: string) => resourceUri.split("/")[2] ?? "";

const fakeCheck = defineCheck({
  checkId: FAKE_CHECK_ID,
  cloud: "gcp",
  scopeOf: fakeScope,
  resourceType: "fake/Thing",
  readFacts: (_resource, fields) => ({ state: str(fields, "state"), weight: num(fields, "weight") }),
  decide: ({ state, weight }, { resource }) => {
    const evidence = { resourceUri: resource.resourceUri, state, weight };
    if (state === null) {
      return undetermined("Read the thing", evidence);
    }
    return state === "bad" ? fail(evidence, FAKE_SAVINGS) : pass(evidence);
  },
});

let postHarvestCalls = 0;
const postHarvest: PostHarvest = {
  apply: (outputs) => {
    postHarvestCalls += 1;
    return outputs;
  },
};

const inventory: Inventory = {
  cloud: "gcp",
  observedAt: "1970-01-01T00:00:00.000Z",
  resources: [
    { resourceUri: "fake://scope-a/thing-1", resourceType: "fake/Thing", region: "r", displayName: "thing-1", tags: {} },
    { resourceUri: "fake://scope-a/thing-2", resourceType: "fake/Thing", region: "r", displayName: "thing-2", tags: {} },
    { resourceUri: "fake://scope-a/other", resourceType: "fake/Other", region: "r", displayName: "other", tags: {} },
  ],
};

const facts: ResourceFacts[] = [
  { resourceUri: "fake://scope-a/thing-1", fields: { state: "bad", weight: 3 } },
  { resourceUri: "fake://scope-a/thing-2", fields: { state: "ok" } },
];

const fakeProvider: CloudProvider = {
  cloud: "gcp",
  launchCheckIds: [FAKE_CHECK_ID, "gcp-fake-unrun"],
  harvestAssessedCheckIds: new Set<string>(),
  requiredRoles: ["fake.viewer"],
  optionalRoles: [],
  scopeOf: fakeScope,
  harvester: (clock) => fixtureHarvester(inventory, facts, clock),
  checks: [fakeCheck],
  collectHarvests: async () => postHarvest,
};

afterEach(() => {
  registerProvider(REAL_GCP);
  postHarvestCalls = 0;
});

describe("cloud provider registration", () => {
  it("lets a provider replace a cloud without edits to store, scans, coverage or runChecks", async () => {
    registerProvider(fakeProvider);
    expect(registeredCheckIds("gcp")).toEqual([FAKE_CHECK_ID]);
    expect(scopeOf("gcp", "fake://scope-a/thing-1")).toBe("scope-a");

    const store = new MemoryStore(fixedClock);
    const connection = await store.putConnection("org-a", { tenantId: "t", subscriptionId: "scope-a", cloud: "gcp" });
    expect(connection.roles).toEqual(["fake.viewer"]);

    const runner = new ScanRunner(store, fakeProvider.harvester(fixedClock), {}, fixedClock);
    const { done } = await runner.start({ orgId: "org-a", subscriptionId: "scope-a", actor: "user" });
    const job = await done;

    expect(job.status).toBe("succeeded");
    expect(job.cloud).toBe("gcp");
    expect(postHarvestCalls).toBe(1);
    const stored = store.snapshot("org-a");
    expect(
      stored.findings.map((finding) => [finding.checkId, finding.result, finding.scope.subscriptionOrProject]),
    ).toEqual([
      [FAKE_CHECK_ID, "fail", "scope-a"],
      [FAKE_CHECK_ID, "pass", "scope-a"],
    ]);
    expect(job.checks.map((check) => check.checkId)).toContain(FAKE_CHECK_ID);
    const failing = stored.findings.find((finding) => finding.result === "fail");
    expect(failing?.savings).toEqual({ min: "1.00", max: "2.00", currency: "USD" });
    expect(failing?.evidence.fields.savingsBasis).toBe("fake basis");
    expect(coverageFromHarvest(["scope-a"], fakeProvider.launchCheckIds, fakeProvider.harvestAssessedCheckIds)).toHaveLength(2);
  });

  it("records the failing cloud's launch checks when a scan fails after harvest", async () => {
    const throwing = defineCheck({
      checkId: "gcp-fake-throws",
      cloud: "gcp",
      scopeOf: fakeScope,
      resourceType: "fake/Thing",
      readFacts: () => null,
      decide: () => {
        throw new Error("boom");
      },
    });
    registerProvider({ ...fakeProvider, checks: [throwing] });
    const store = new MemoryStore(fixedClock);
    await store.putConnection("org-a", { tenantId: "t", subscriptionId: "scope-a", cloud: "gcp" });
    const runner = new ScanRunner(store, fakeProvider.harvester(fixedClock), {}, fixedClock);
    const job = await (await runner.start({ orgId: "org-a", subscriptionId: "scope-a", actor: "user" })).done;
    expect(job.status).toBe("failed");
    expect(job.checks.map((check) => check.checkId)).toEqual([...fakeProvider.launchCheckIds]);
  });

  it("accepts a registered cloud on connect and rejects an unknown one", async () => {
    const app = buildApp(new MemoryStore(fixedClock), TEST_APP_OPTIONS);
    const headers = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
    const connect = (cloud: string) =>
      app.inject({
        method: "PUT",
        url: "/v1/orgs/org-a/connections",
        headers,
        payload: { tenantId: "tenant-1", subscriptionId: "main", cloud },
      });
    const accepted = await connect("gcp");
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().cloud).toBe("gcp");
    expect((await connect("aws")).statusCode).toBe(400);
    await app.close();
  });

  it("stores the connection cloud", async () => {
    const store = new MemoryStore(fixedClock);
    expect((await store.putConnection("org-a", { tenantId: "t", subscriptionId: "s" })).cloud).toBe("azure");
    expect((await store.putConnection("org-a", { tenantId: "t", subscriptionId: "p", cloud: "gcp" })).cloud).toBe("gcp");
  });
});

describe("defineCheck", () => {
  it("returns findings with exact scope, savings basis and closer shape", () => {
    registerProvider(fakeProvider);
    const { findings } = runChecks({ inventory, facts: [], checkIds: [FAKE_CHECK_ID] });
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.result === "undetermined" && finding.closer === "Read the thing")).toBe(
      true,
    );
    expect(findings[0]?.scope).toEqual({ id: "scope-a:gcp-fake-things", cloud: "gcp", subscriptionOrProject: "scope-a" });
  });

  it("builds the facts index once per runChecks", () => {
    let mapCalls = 0;
    const counted = new Proxy(facts, {
      get(target, property, receiver) {
        if (property === "map") {
          mapCalls += 1;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    registerProvider(fakeProvider);
    runChecks({ inventory, facts: counted, checkIds: [FAKE_CHECK_ID, FAKE_CHECK_ID, FAKE_CHECK_ID] });
    expect(mapCalls).toBe(1);
  });

  it("reuses a prebuilt index when one is passed", () => {
    const rows = indexFacts(facts);
    expect(fakeCheck(inventory, [], undefined, rows).map((finding) => finding.result)).toEqual(["fail", "pass"]);
  });

  it("skips resources whose decide returns null", () => {
    const skipAll = defineCheck({
      checkId: "gcp-skip",
      cloud: "gcp",
      scopeOf: fakeScope,
      readFacts: () => null,
      decide: () => null,
    });
    expect(skipAll(inventory, facts)).toEqual([]);
  });
});
