import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../backend/src/app.ts";
import { MemoryStore } from "../../backend/src/store.ts";
import { TEST_ISSUER, testClaims, testIdentity, testSigner } from "../../backend/src/test-identity.ts";
import { configFrom, rehearse, SKIPPED } from "./run.mjs";

const RUNNER = fileURLToPath(new URL("./run.mjs", import.meta.url));
const signer = testSigner("RS256");
const nowS = Math.floor(Date.now() / 1000);
const token = (claims) => signer.sign(testClaims(nowS, claims));
const OWNER = token({ sub: "cto", org: "tenant-a" });
const MEMBER = token({ sub: "engineer", org: "tenant-a" });
const OTHER = token({ sub: "intruder", org: "tenant-b" });

function serve(options) {
  const app = buildApp(new MemoryStore(), options);
  return app.listen({ port: 0, host: "127.0.0.1" }).then((address) => ({ app, address }));
}

function envFor(apiUrl, overrides = {}) {
  return {
    FARSIDE_REHEARSAL_API_URL: apiUrl,
    FARSIDE_REHEARSAL_ISSUER: TEST_ISSUER,
    FARSIDE_REHEARSAL_OWNER_TOKEN: OWNER,
    FARSIDE_REHEARSAL_MEMBER_TOKEN: MEMBER,
    FARSIDE_REHEARSAL_OTHER_TOKEN: OTHER,
    FARSIDE_REHEARSAL_ORG_CLAIM: "org",
    ...overrides,
  };
}

describe("identity rehearsal without a test tenant", () => {
  it("skips and exits 0", () => {
    const run = spawnSync(process.execPath, [RUNNER], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(SKIPPED);
  });

  it("reports a half-configured tenant instead of skipping", () => {
    expect(configFrom({ FARSIDE_REHEARSAL_ISSUER: TEST_ISSUER }).errors).toEqual(
      expect.arrayContaining(["FARSIDE_REHEARSAL_API_URL is required", "FARSIDE_REHEARSAL_OWNER_TOKEN is required"]),
    );
    const run = spawnSync(process.execPath, [RUNNER], {
      env: { PATH: process.env.PATH, FARSIDE_REHEARSAL_ISSUER: TEST_ISSUER },
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("FARSIDE_REHEARSAL_OWNER_TOKEN is required");
  });

  it("needs a second org for the cross-org check and tokens from the configured issuer", () => {
    const base = envFor("http://x", { FARSIDE_REHEARSAL_OTHER_TOKEN: "", FARSIDE_REHEARSAL_MEMBER_TOKEN: "" });
    expect(configFrom(base).errors?.[0]).toContain("FARSIDE_REHEARSAL_OTHER_ORG");
    expect(configFrom({ ...base, FARSIDE_REHEARSAL_OTHER_ORG: "tenant-a" }).errors?.[0]).toContain("different org");
    expect(configFrom({ ...base, FARSIDE_REHEARSAL_OTHER_ORG: "tenant-b" }).config?.otherOrgId).toBe("tenant-b");
    expect(configFrom({ ...base, FARSIDE_REHEARSAL_ISSUER: "https://other.invalid", FARSIDE_REHEARSAL_OTHER_ORG: "b" }).errors).toEqual([
      "the owner token was not issued by FARSIDE_REHEARSAL_ISSUER",
    ]);
  });
});

describe("identity rehearsal against a running backend", () => {
  let identity;
  let header;

  beforeAll(async () => {
    identity = await serve({ identity: testIdentity([signer]) });
    header = await serve({});
  });

  afterAll(async () => {
    await identity.app.close();
    await header.app.close();
  });

  it("passes claim, sign-in, join, org-scoped read and cross-org 403, and writes a dated record without tokens", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "identity-rehearsal-"));
    const first = await rehearse({ env: envFor(identity.address), outDir, now: () => new Date("2026-11-09T12:00:00Z") });
    expect(first.status).toBe("pass");
    expect(first.record.steps.map((item) => [item.id, item.status])).toEqual([
      ["header-stand-in-refused", 401],
      ["claim", 201],
      ["claim-idempotent", 200],
      ["sign-in", 200],
      ["join", 200],
      ["org-scoped-read", 200],
      ["cross-org-403", 403],
      ["cross-org-403-reverse", 403],
      ["cross-org-claim-403", 403],
    ]);
    const written = readFileSync(first.file, "utf8");
    expect(first.file).toMatch(/2026-11-09-claim-rehearsal\.json$/);
    for (const secret of [OWNER, MEMBER, OTHER]) {
      expect(written).not.toContain(secret);
    }
    expect(JSON.parse(written)).toMatchObject({ result: "pass", orgId: "tenant-a", otherOrgId: "tenant-b", liveRunAt: "2026-11-09" });

    const rerun = await rehearse({ env: envFor(identity.address), outDir, now: () => new Date("2026-11-09T13:00:00Z") });
    expect(rerun.status).toBe("pass");
    expect(rerun.record.steps.find((item) => item.id === "claim")?.detail).toBe("outcome existing, role owner");
    expect(readdirSync(outDir).sort()).toEqual(["2026-11-09-claim-rehearsal-2.json", "2026-11-09-claim-rehearsal.json"]);
  });

  it("fails, and records the failure, when the backend still runs on the header session", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "identity-rehearsal-"));
    const outcome = await rehearse({ env: envFor(header.address), outDir });
    expect(outcome.status).toBe("fail");
    expect(outcome.record.steps[0]).toMatchObject({ id: "header-stand-in-refused", ok: false });
    expect(JSON.parse(readFileSync(outcome.file, "utf8")).result).toBe("fail");
  });

  it("exits 1 from the CLI when a step fails", () => {
    const outDir = mkdtempSync(join(tmpdir(), "identity-rehearsal-"));
    const run = spawnSync(process.execPath, [RUNNER], {
      env: { PATH: process.env.PATH, ...envFor("http://127.0.0.1:9"), FARSIDE_REHEARSAL_OUT: outDir },
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("FAIL header-stand-in-refused");
    expect(readdirSync(outDir)).toHaveLength(1);
  });
});
