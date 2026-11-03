import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { parseContract } from "./billing.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { fixtureHarvester } from "./scans.js";
import { DEMO_ORG_ID } from "./demo.js";
import { ACTOR_HEADER, OPERATOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;
const SECRET_MESSAGE = "secret-tenant-xyz timeout";
const OPERATOR_TOKEN = "op-token-value";
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

type LogLine = Record<string, unknown>;

function captureLogs() {
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const text of String(chunk).split("\n").filter(Boolean)) {
        lines.push(JSON.parse(text) as LogLine);
      }
      done();
    },
  });
  return { lines, stream };
}

const apps: { close: () => Promise<undefined> }[] = [];

function build(
  options: Parameters<typeof buildApp>[1] = {},
  store = new MemoryStore(fixedClock),
) {
  const logs = captureLogs();
  const app = buildApp(store, {
    ...TEST_APP_OPTIONS,
    operatorToken: OPERATOR_TOKEN,
    logger: { level: "info", stream: logs.stream },
    ...options,
  });
  apps.push(app);
  return { app, store, lines: logs.lines };
}

function events(lines: LogLine[], event: string) {
  return lines.filter((line) => line.event === event);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("request logging", () => {
  it("emits exactly one response line with request id, org, route, status and latency", async () => {
    const { app, lines } = build();
    const response = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/connections",
      headers: {
        ...ORG,
        [OPERATOR_HEADER]: OPERATOR_TOKEN,
        authorization: "Bearer sekrit-bearer",
      },
    });
    expect(response.statusCode).toBe(200);
    const completed = lines.filter((line) => line.msg === "request completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      reqId: response.headers["x-request-id"],
      orgId: "org-a",
      actorId: "actor-a",
      route: "/v1/orgs/:orgId/connections",
      method: "GET",
      status: 200,
    });
    expect(completed[0]?.latencyMs).toEqual(expect.any(Number));
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain(OPERATOR_TOKEN);
    expect(raw).not.toContain("sekrit-bearer");
  });

  it("still sets a request id header when logging is not configured", async () => {
    const app = buildApp(new MemoryStore(fixedClock), TEST_APP_OPTIONS);
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
  });
});

describe("audit lines", () => {
  it("emits one offboard audit line with org and actor and no body", async () => {
    const { app, lines } = build();
    const response = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/offboard",
      headers: ORG,
      payload: { confirm: true, exportOffered: true, note: "body-marker-123" },
    });
    expect(response.statusCode).toBe(200);
    const audits = events(lines, "org.offboard");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      orgId: "org-a",
      actorId: "actor-a",
      trigger: "customer",
    });
    expect(JSON.stringify(lines)).not.toContain("body-marker-123");
  });

  it("audits connect, disconnect, settings change and operator contract change", async () => {
    const { app, lines } = build();
    const put = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: { tenantId: "tenant-a", subscriptionId: "main" },
    });
    await app.inject({
      method: "DELETE",
      url: `/v1/orgs/org-a/connections/${put.json().id}`,
      headers: ORG,
    });
    await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/settings",
      headers: ORG,
      payload: {
        ownerTagKey: "owner",
        productionTagKey: "environment",
        productionTagValue: "prod",
      },
    });
    await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/contract",
      headers: { [OPERATOR_HEADER]: OPERATOR_TOKEN },
      payload: {
        plan: "farside-standard",
        startDate: "2026-10-01T00:00:00.000Z",
      },
    });
    for (const event of [
      "connection.connect",
      "connection.disconnect",
      "settings.change",
    ]) {
      expect(events(lines, event)).toEqual([
        expect.objectContaining({ orgId: "org-a", actorId: "actor-a" }),
      ]);
    }
    expect(events(lines, "contract.change")).toEqual([
      expect.objectContaining({ orgId: "org-a", actorId: "operator" }),
    ]);
  });

  it("audits 401, 403 and 409 responses", async () => {
    const later = "2026-01-25T00:00:00.000Z";
    const store = new MemoryStore(() => later);
    const { app, lines } = build({ clock: () => later }, store);
    const start = "2026-01-01T00:00:00.000Z";
    store.putContract(
      "org-paused",
      parseContract({ plan: "p", startDate: start, unpaidAt: start }, start),
    );
    const paused = { [ORG_HEADER]: "org-paused", [ACTOR_HEADER]: "actor-p" };
    await app.inject({ method: "GET", url: "/v1/orgs/org-a/connections" });
    await app.inject({
      method: "GET",
      url: "/v1/orgs/org-b/connections",
      headers: ORG,
    });
    await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-paused/settings",
      headers: paused,
      payload: {},
    });
    expect(events(lines, "http.401")).toHaveLength(1);
    expect(events(lines, "http.403")).toEqual([
      expect.objectContaining({ orgId: "org-b", actorId: "actor-a" }),
    ]);
    expect(events(lines, "http.409")).toEqual([
      expect.objectContaining({ orgId: "org-paused", actorId: "actor-p" }),
    ]);
  });

  it("audits a lazy retention offboard as the system", async () => {
    let now = "2026-10-01T00:00:00.000Z";
    const store = new MemoryStore(() => now);
    const { app, lines } = build({ clock: () => now }, store);
    store.putContract(
      "org-a",
      parseContract({ plan: "p", startDate: now, unpaidAt: now }, now),
    );
    now = "2026-12-01T00:00:00.000Z";
    const response = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
    });
    expect(response.statusCode).toBe(410);
    expect(events(lines, "org.offboard")).toEqual([
      expect.objectContaining({
        orgId: "org-a",
        actorId: "system",
        trigger: "retention",
      }),
    ]);
  });
});

describe("error handling", () => {
  it("hides a thrown message behind a problem+json 500 whose errorId is in the log", async () => {
    const { app, lines } = build({
      budgetClient: {
        list: vi.fn(async () => {
          throw new Error(SECRET_MESSAGE);
        }),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/budgets",
      headers: ORG,
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toContain(
      "application/problem+json",
    );
    expect(response.body).not.toContain("secret-tenant-xyz");
    const body = response.json();
    expect(body).toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      errorId: expect.any(String),
    });
    const logged = lines.find((line) => line.errorId === body.errorId);
    expect(logged).toMatchObject({
      level: 50,
      reqId: response.headers["x-request-id"],
      orgId: "org-a",
    });
  });

  it("keeps the default shape for client errors", async () => {
    const { app } = build();
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/settings",
      headers: { ...ORG, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      code: "FST_ERR_CTP_INVALID_JSON_BODY",
    });
  });

  it("stores a coded scan failure and keeps the raw message out of GET /scans", async () => {
    const { app, lines } = build({
      harvester: {
        async harvest() {
          throw new Error(SECRET_MESSAGE);
        },
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    await vi.waitFor(() =>
      expect(events(lines, "scan.failed")).toHaveLength(1),
    );
    const listed = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
    });
    expect(listed.body).not.toContain("secret-tenant-xyz");
    const [scan] = listed.json().scans;
    expect(scan).toMatchObject({ status: "failed", error: "harvest_failed" });
    expect(events(lines, "scan.start")).toHaveLength(1);
    expect(events(lines, "scan.failed")[0]).not.toHaveProperty("subscriptionId");
    expect(events(lines, "scan.failed")[0]).toMatchObject({
      scanId: scan.id,
      orgId: "org-a",
      errorCode: "harvest_failed",
      errorId: scan.errorId,
      checkCount: expect.any(Number),
    });
  });

  it("logs scan start and finish with duration and check counts", async () => {
    const { app, lines } = build({ harvester: fixtureHarvester(inventoryFromManifest(MANIFEST)) });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    await vi.waitFor(() =>
      expect(events(lines, "scan.finish")).toHaveLength(1),
    );
    expect(events(lines, "scan.start")[0]).not.toHaveProperty("subscriptionId");
    expect(events(lines, "scan.finish")[0]).not.toHaveProperty("subscriptionId");
    expect(events(lines, "scan.finish")[0]).toMatchObject({
      orgId: "org-a",
      scanId: "scan-1",
      durationMs: expect.any(Number),
      checkCount: expect.any(Number),
    });
  });

  it("hides a SecretLeakError path behind a problem+json 500", async () => {
    const { app } = build();
    const orgId = "AKIAIOSFODNN7EXAMPLE";
    const response = await app.inject({
      method: "GET",
      url: `/v1/orgs/${orgId}/export/cost`,
      headers: { [ORG_HEADER]: orgId, [ACTOR_HEADER]: "actor-a" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).not.toContain("secret or token pattern");
    expect(response.body).not.toContain(orgId);
    expect(response.json().errorId).toEqual(expect.any(String));
  });

  it("stores harvest_timeout for a timeout error", async () => {
    const { app, lines } = build({
      harvester: {
        async harvest() {
          throw Object.assign(new Error(SECRET_MESSAGE), { name: "TimeoutError" });
        },
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    await vi.waitFor(() => expect(events(lines, "scan.failed")).toHaveLength(1));
    expect(events(lines, "scan.failed")[0]).toMatchObject({ errorCode: "harvest_timeout" });
    const listed = await app.inject({ method: "GET", url: "/v1/orgs/org-a/scans", headers: ORG });
    expect(listed.json().scans[0].error).toBe("harvest_timeout");
  });

  it("logs scan.cancelled when the org is offboarded mid-harvest", async () => {
    let fail!: (error: Error) => void;
    const gate = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const { app, store, lines } = build({ harvester: { harvest: () => gate } });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    store.offboard("org-a");
    fail(new Error(SECRET_MESSAGE));
    await vi.waitFor(() => expect(events(lines, "scan.cancelled")).toHaveLength(1));
    expect(events(lines, "scan.cancelled")[0]).toMatchObject({ orgId: "org-a", scanId: "scan-1" });
    expect(events(lines, "scan.failed")).toHaveLength(0);
  });

  it("audits http.403 from the operator guard and the demo read-only branch", async () => {
    const { app, lines } = build();
    await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/contract",
      headers: { [OPERATOR_HEADER]: "wrong-token" },
      payload: { plan: "p", startDate: "2026-10-01T00:00:00.000Z" },
    });
    await app.inject({
      method: "PUT",
      url: `/v1/orgs/${DEMO_ORG_ID}/settings`,
      headers: { [ORG_HEADER]: DEMO_ORG_ID, [ACTOR_HEADER]: "actor-d" },
      payload: {},
    });
    expect(events(lines, "http.403")).toEqual([
      expect.objectContaining({ orgId: "org-a", title: "Forbidden" }),
      expect.objectContaining({ orgId: DEMO_ORG_ID, actorId: "actor-d", title: "Demo is read-only" }),
    ]);
  });
});
