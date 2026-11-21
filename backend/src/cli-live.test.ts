import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAKE_CLIENT_ID,
  FAKE_SUBSCRIPTIONS,
  FAKE_TENANT_ID,
  fakeAzure,
  fakeJwt,
  type FakeAzureOptions,
} from "./azure-fake.js";
import { EXIT_FAILED, EXIT_OK, runCli } from "./cli.js";
import { causeChain, liveRequested } from "./cli-live.js";
import { FederatedExchangeError } from "./azure-federated.js";
import { GcpFederationError } from "./gcp-federation.js";

const NOW = "2026-11-02T12:00:00.000Z";
const clock = () => NOW;
const ASSERTION = fakeJwt({ iss: "https://sts.amazonaws.com", sub: "farside-runtime" });
const SUBSCRIPTION = FAKE_SUBSCRIPTIONS.main;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function assertionFile(): string {
  const path = join(tmp("farside-cli-live-"), "token");
  writeFileSync(path, ASSERTION);
  return path;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: { write: (chunk: string) => void out.push(chunk) },
    stderr: { write: (chunk: string) => void err.push(chunk) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const azureEnv = (extra: Record<string, string> = {}) => ({
  FARSIDE_AZURE_LIVE: "1",
  FARSIDE_AZURE_CLIENT_ID: FAKE_CLIENT_ID,
  AWS_WEB_IDENTITY_TOKEN_FILE: assertionFile(),
  FARSIDE_AZURE_TENANT_ID: FAKE_TENANT_ID,
  ...extra,
});

function azureScan(options: Partial<FakeAzureOptions> = {}, env = azureEnv()) {
  const azure = fakeAzure({ now: () => new Date(NOW), ...options });
  const io = capture();
  const dir = tmp("farside-cli-ws-");
  const run = () =>
    runCli(["scan", "--cloud", "azure", "--scope", SUBSCRIPTION, "--workspace", dir], {
      ...io,
      env,
      clock,
      liveDeps: { fetch: azure.fetch },
    });
  return { azure, io, dir, run };
}

describe("liveRequested", () => {
  it("is on only for the cloud whose switch is 1", () => {
    expect(liveRequested("azure", {})).toBe(false);
    expect(liveRequested("azure", { FARSIDE_AZURE_LIVE: "1" })).toBe(true);
    expect(liveRequested("gcp", { FARSIDE_AZURE_LIVE: "1" })).toBe(false);
    expect(liveRequested("gcp", { FARSIDE_GCP_LIVE: "1" })).toBe(true);
    expect(liveRequested("azure", { FARSIDE_AZURE_LIVE: "true" })).toBe(false);
  });
});

describe("farside CLI: a live Azure scan", () => {
  it("scans through the live harvester, writes the workspace, and never prints the assertion", async () => {
    const { azure, io, dir, run } = azureScan();
    expect(await run()).toBe(EXIT_OK);
    expect(JSON.parse(io.out())).toMatchObject({
      status: "succeeded",
      cloud: "azure",
      scope: SUBSCRIPTION,
    });
    expect(readdirSync(dir)).toEqual(
      expect.arrayContaining(["findings.json", "issues.json", "state.json"]),
    );
    expect(azure.tokensIssued()).toBeGreaterThan(0);
    expect(io.out() + io.err()).not.toContain(ASSERTION);
  });

  it("does not need a local sign-in when live is switched on", async () => {
    const { run } = azureScan(); // no probe injected, no ~/.azure: the live path must not ask for them
    expect(await run()).toBe(EXIT_OK);
  });

  it("names a refused federation with its Entra code, writes nothing, and exits 1", async () => {
    const { io, dir, run } = azureScan({ fail: { token: 401 } });
    expect(await run()).toBe(EXIT_FAILED);
    expect(io.err()).toContain("FederatedExchangeError");
    expect(io.err()).not.toContain(ASSERTION);
    expect(existsSync(join(dir, "findings.json"))).toBe(false);
  });

  it("prints the cause chain when the harvest fails after sign-in", async () => {
    const { io, dir, run } = azureScan({ fail: { graph: 403 } });
    expect(await run()).toBe(EXIT_FAILED);
    type Line = { failed?: string; cause?: Array<{ name: string; status?: number }> };
    const failure = io
      .err()
      .split("\n")
      .filter(Boolean)
      .flatMap((line): Line[] => {
        try {
          return [JSON.parse(line) as Line];
        } catch {
          return []; // the CLI's own plain "harvest_failed" line
        }
      })
      .find((line) => line.failed !== undefined);
    expect(failure?.failed).toBe("harvest_failed");
    expect(failure?.cause?.map((item) => item.name)).toEqual([
      "ScanFailedError",
      "ResourceGraphFailedCallError",
      "AzureAccessDeniedError",
    ]);
    expect(failure?.cause?.at(-1)?.status).toBe(403);
    expect(existsSync(join(dir, "findings.json"))).toBe(false);
  });

  it("refuses an incomplete configuration with a fixed message", async () => {
    const withoutTenant = azureScan({}, { ...azureEnv(), FARSIDE_AZURE_TENANT_ID: "" });
    expect(await withoutTenant.run()).toBe(EXIT_FAILED);
    expect(withoutTenant.io.err()).toContain("FARSIDE_AZURE_TENANT_ID");

    const withoutClient = azureScan({}, { ...azureEnv(), FARSIDE_AZURE_CLIENT_ID: "" });
    expect(await withoutClient.run()).toBe(EXIT_FAILED);
    expect(withoutClient.io.err()).toContain("FARSIDE_AZURE_CLIENT_ID");
  });

  it("refuses a client secret, as the backend does", async () => {
    const { io, run } = azureScan({}, { ...azureEnv(), AZURE_CLIENT_SECRET: "not-for-live" });
    expect(await run()).toBe(EXIT_FAILED);
    expect(io.err()).toContain("client secrets are refused");
    expect(io.err()).not.toContain("not-for-live");
  });

  it("names the missing roles it found on the scope", async () => {
    const { io, run } = azureScan({ roles: ["Reader"] });
    await run();
    expect(io.err()).toContain("missingRoles");
  });
});

describe("farside CLI: without live switched on, nothing changes", () => {
  it("still fails a live scan with no credentials, exactly as before", async () => {
    const io = capture();
    const code = await runCli(
      ["scan", "--cloud", "azure", "--scope", SUBSCRIPTION, "--workspace", tmp("farside-cli-ws-")],
      {
        ...io,
        env: {},
        clock,
        probe: () => ({ present: false, source: "none", error: "no credentials" }),
      },
    );
    expect(code).toBe(EXIT_FAILED);
    expect(io.err()).toContain("no credentials");
  });
});

describe("farside CLI: a live GCP scan", () => {
  const gcpEnv = {
    FARSIDE_GCP_LIVE: "1",
    FARSIDE_GCP_PROJECT_ID: "farside-test",
    FARSIDE_GCP_POOL_PROJECT_NUMBER: "123456789",
    FARSIDE_GCP_POOL_ID: "farside-pool",
    FARSIDE_GCP_PROVIDER_ID: "farside-aws",
    FARSIDE_GCP_SERVICE_ACCOUNT: "farside-reader@farside-test.iam.gserviceaccount.com",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
  };

  function gcpScan(scope: string, fetch: (input: string, init: RequestInit) => Promise<Response>) {
    const io = capture();
    const dir = tmp("farside-cli-ws-");
    const run = () =>
      runCli(["scan", "--cloud", "gcp", "--scope", scope, "--workspace", dir], {
        ...io,
        env: gcpEnv,
        clock,
        liveDeps: { fetch, readFile: async () => "SECRET-OIDC-TOKEN" },
      });
    return { io, dir, run };
  }

  it("refuses a scope other than the configured project, before any network call", async () => {
    let calls = 0;
    const { io, run } = gcpScan("some-other-project", async () => {
      calls += 1;
      return Response.json({});
    });
    expect(await run()).toBe(EXIT_FAILED);
    expect(io.err()).toContain("farside-test");
    expect(calls).toBe(0);
  });

  it("reports a refused federation with its step and status, and never the token", async () => {
    const { io, run } = gcpScan("farside-test", async () =>
      Response.json({ error: "invalid_target" }, { status: 400 }),
    );
    await run();
    expect(io.err()).toContain("gcp harvest failed");
    expect(io.err()).toContain("GcpFederationError");
    expect(io.err()).toContain('"step":"sts"');
    for (const secret of ["SECRET-OIDC-TOKEN", "invalid_target"]) {
      expect(io.out() + io.err()).not.toContain(secret);
    }
  });
});

describe("causeChain", () => {
  it("lists the safe fields of an error and each cause, in order", () => {
    const error = new Error("outer", { cause: new FederatedExchangeError(401, "AADSTS70021") });
    expect(causeChain(error)).toEqual([
      { name: "Error" },
      { name: "FederatedExchangeError", status: 401, code: "AADSTS70021" },
    ]);
    expect(causeChain(new GcpFederationError("sts", 400))).toEqual([
      { name: "GcpFederationError", status: 400, step: "sts" },
    ]);
  });

  it("stops at the depth limit and handles a non-error", () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(causeChain(loop, 3)).toHaveLength(3);
    expect(causeChain(undefined)).toEqual([]);
  });
});
