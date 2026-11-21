import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifestJson from "../../docs/gcp/ground-truth.json" with { type: "json" };
import { fixtureAssetsFromManifest } from "./cloud-asset.js";
import type { GcpGroundTruthManifest } from "./gcp-inventory.js";
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
import { issueIdentity, resourceIdFromFinding } from "./issues.js";
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
  // An empty home, so a ~/.azure on the machine running the tests cannot stand in for the live credentials.
  HOME: tmp("farside-cli-home-"),
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

  it("fails the scan on a refused federation: exit 1, the cause named, and the workspace left untouched", async () => {
    const { io, dir, run } = gcpScan("farside-test", async () =>
      Response.json({ error: "invalid_target" }, { status: 400 }),
    );
    // An earlier live scan with an open issue. A refused read must not close it or empty the findings.
    const prior = {
      "state.json": JSON.stringify({
        version: 1,
        scans: [
          {
            id: "scan-1",
            cloud: "gcp",
            scope: "farside-test",
            status: "succeeded",
            finishedAt: null,
            source: "live",
          },
        ],
        inventories: {},
        costs: {},
      }),
      "issues.json": JSON.stringify([
        { id: "i-1", checkId: "gcp-waste-unattached-disks", status: "open" },
      ]),
      "findings.json": JSON.stringify([{ checkId: "gcp-waste-unattached-disks", result: "fail" }]),
    };
    for (const [name, text] of Object.entries(prior)) {
      writeFileSync(join(dir, name), text);
    }
    expect(await run()).toBe(EXIT_FAILED);
    expect(io.err()).toContain("gcp harvest failed");
    expect(io.err()).toContain('"failed":"harvest_failed"');
    const chain = io
      .err()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [
            JSON.parse(line) as { cause?: Array<{ name: string; status?: number; step?: string }> },
          ];
        } catch {
          return [];
        }
      })
      .find((line) => line.cause !== undefined);
    expect(chain?.cause?.map((item) => item.name)).toEqual([
      "ScanFailedError",
      "GcpFederationError",
    ]);
    expect(chain?.cause?.at(-1)).toMatchObject({ status: 400, step: "sts" });
    expect(io.out()).toBe("");
    for (const [name, text] of Object.entries(prior)) {
      expect(readFileSync(join(dir, name), "utf8")).toBe(text);
    }
    for (const secret of ["SECRET-OIDC-TOKEN", "invalid_target"]) {
      expect(io.out() + io.err()).not.toContain(secret);
    }
  });

  describe("a successful scan of a seeded project", () => {
    const assets = fixtureAssetsFromManifest(manifestJson as GcpGroundTruthManifest).filter(
      (asset) => asset.id !== "gke-stale" && !asset.assetType.startsWith("recommender"),
    );
    const fetch = async (url: string) => {
      if (url.startsWith("https://sts.googleapis.com/")) {
        return Response.json({ access_token: "federated" });
      }
      if (url.startsWith("https://iamcredentials.googleapis.com/")) {
        return Response.json({ accessToken: "impersonated", expireTime: "2026-12-01T10:00:00Z" });
      }
      if (url.startsWith("https://cloudasset.googleapis.com/")) {
        const type = new URL(url).searchParams.get("assetTypes");
        return Response.json({
          assets: assets
            .filter((asset) => asset.assetType === type)
            .map((asset) => ({
              name: asset.name,
              assetType: asset.assetType,
              resource: { location: asset.location, data: { labels: asset.labels } },
            })),
        });
      }
      if (url.startsWith("https://recommender.googleapis.com/")) {
        return Response.json({}, { status: 403 }); // Recommender Viewer is not granted
      }
      return Response.json({});
    };

    it("writes a marked live scan, and says nothing about the committed-use check it cannot assess", async () => {
      const { io, dir, run } = gcpScan("farside-test", fetch);
      expect(await run()).toBe(EXIT_OK);
      const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as Array<{
        checkId: string;
      }>;
      const coverage = JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8")) as Array<{
        checkId: string;
        state: string;
        causeId?: string;
        closer?: string;
      }>;
      const issues = JSON.parse(readFileSync(join(dir, "issues.json"), "utf8")) as Array<{
        checkId: string;
      }>;
      // The registered committed-use check reads fixture commitments for any project, so nothing from it may be saved.
      expect(findings.some((finding) => finding.checkId === "gcp-cost-committed-use")).toBe(false);
      expect(issues.some((issue) => issue.checkId === "gcp-cost-committed-use")).toBe(false);
      expect(coverage.find((entry) => entry.checkId === "gcp-cost-committed-use")).toMatchObject({
        state: "unassessed",
        causeId: "not_run",
        closer: "Enable the BigQuery billing export",
      });
      // The Recommender read was refused, so the idle check is unassessed for a named reason, not "assessed, none found".
      expect(
        coverage.find((entry) => entry.checkId === "gcp-waste-idle-vm-and-disk-recommendations"),
      ).toMatchObject({
        state: "unassessed",
        causeId: "missing_role",
      });
      expect(
        findings.some(
          (finding) => finding.checkId === "gcp-waste-idle-vm-and-disk-recommendations",
        ),
      ).toBe(false);
      // The checks that really ran on the live read still report.
      // The mocked asset bodies carry no disk properties, so that check is undetermined, and stays undetermined.
      expect(coverage.find((entry) => entry.checkId === "gcp-waste-unattached-disks")?.state).toBe(
        "undetermined",
      );
      const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {
        scans: Array<{ source?: string }>;
      };
      expect(state.scans.map((scan) => scan.source)).toEqual(["live"]);
      const printed = JSON.parse(io.out()) as {
        coverageSummary: { assessed: number; unassessed: number };
      };
      expect(printed.coverageSummary.unassessed).toBeGreaterThanOrEqual(2);
      expect(io.out() + io.err()).not.toContain("SECRET-OIDC-TOKEN");
    });

    const IDLE = "gcp-waste-idle-vm-and-disk-recommendations";
    const idleFinding = (project: string) => ({
      checkId: IDLE,
      result: "fail",
      evidence: { fields: { recommendationId: `rec-${project}` } },
      scope: { id: `${project}:${IDLE}`, cloud: "gcp", subscriptionOrProject: project },
      savings: { min: "0.00", max: "12.50", currency: "USD" },
    });
    const idleIssue = (project: string) => {
      const finding = idleFinding(project) as unknown as Parameters<
        typeof resourceIdFromFinding
      >[0];
      const resourceId = resourceIdFromFinding(finding);
      return {
        id: issueIdentity(IDLE, resourceId, `${project}:${IDLE}`),
        checkId: IDLE,
        resourceId,
        scopeId: `${project}:${IDLE}`,
        cloud: "gcp",
        subscriptionOrProject: project,
        status: "open",
        coverage: "assessed",
        firstSeen: "2026-10-01T00:00:00.000Z",
        lastConfirmed: "2026-10-30T00:00:00.000Z",
        savings: { min: "0.00", max: "12.50", currency: "USD" },
      };
    };
    const idleCoverage = (project: string) => ({
      id: `${project}:${IDLE}`,
      checkId: IDLE,
      cloud: "gcp",
      subscriptionOrProject: project,
      state: "assessed",
    });
    function seed(dir: string, projects: string[]) {
      const files = {
        "state.json": {
          version: 1,
          scans: projects.map((scope, index) => ({
            id: `scan-${index + 1}`,
            cloud: "gcp",
            scope,
            status: "succeeded",
            finishedAt: null,
            source: "live",
          })),
          inventories: {},
          costs: {},
        },
        "findings.json": projects.map(idleFinding),
        "issues.json": projects.map(idleIssue),
        "coverage.json": projects.map(idleCoverage),
      };
      for (const [name, value] of Object.entries(files)) {
        writeFileSync(join(dir, name), JSON.stringify(value));
      }
      return files;
    }
    const read = (dir: string, name: string) =>
      JSON.parse(readFileSync(join(dir, name), "utf8")) as Array<Record<string, unknown>>;

    it("keeps a real finding from a check that did run", async () => {
      const { dir, run } = gcpScan("farside-test", fetch);
      expect(await run()).toBe(EXIT_OK);
      const findings = read(dir, "findings.json") as Array<{ checkId: string }>;
      expect(findings.length).toBeGreaterThan(0);
      expect(
        findings.every(
          (finding) => finding.checkId !== "gcp-cost-committed-use" && finding.checkId !== IDLE,
        ),
      ).toBe(true);
    });

    it("leaves another project's findings, issues and coverage exactly as they were", async () => {
      const { dir, run } = gcpScan("farside-test", fetch);
      const before = seed(dir, ["project-a"]);
      expect(await run()).toBe(EXIT_OK);
      expect(
        read(dir, "findings.json").filter(
          (row) =>
            (row.scope as { subscriptionOrProject: string }).subscriptionOrProject === "project-a",
        ),
      ).toEqual(before["findings.json"]);
      // The scan re-confirms an open issue whose finding is still stored (it refreshes lastConfirmed), so compare identity
      // and status, which are what a wrongly dropped or closed issue would change.
      const issues = read(dir, "issues.json").filter(
        (row) => row.subscriptionOrProject === "project-a",
      );
      expect(issues.map((row) => [row.id, row.checkId, row.status])).toEqual(
        (before["issues.json"] as Array<Record<string, unknown>>).map((row) => [
          row.id,
          row.checkId,
          "open",
        ]),
      );
      expect(
        read(dir, "coverage.json").filter((row) => row.subscriptionOrProject === "project-a"),
      ).toEqual(before["coverage.json"]);
    });

    it("does not close or drop the project's own earlier issue when a rescan cannot assess its check", async () => {
      const { dir, run } = gcpScan("farside-test", fetch);
      const before = seed(dir, ["farside-test"]);
      expect(await run()).toBe(EXIT_OK);
      expect(read(dir, "issues.json").filter((row) => row.checkId === IDLE)).toEqual(
        before["issues.json"],
      );
      expect(read(dir, "findings.json").filter((row) => row.checkId === IDLE)).toEqual(
        before["findings.json"],
      );
      expect(read(dir, "coverage.json").find((row) => row.checkId === IDLE)).toMatchObject({
        state: "unassessed",
        causeId: "missing_role",
      });
    });
  });

  it.each([
    ["Cloud Asset answers 401", "https://cloudasset.googleapis.com/", 401, "GcpAuthError"],
    ["Cloud Asset answers 403", "https://cloudasset.googleapis.com/", 403, "GcpAccessDeniedError"],
    ["Cloud Asset answers 500", "https://cloudasset.googleapis.com/", 500, "GcpApiError"],
    [
      "the service account token call answers 500",
      "https://iamcredentials.googleapis.com/",
      500,
      "GcpFederationError",
    ],
  ])(
    "fails the scan and leaves a prior workspace byte-identical when %s",
    async (_name, prefix, status, errorName) => {
      const { io, dir, run } = gcpScan("farside-test", async (url: string) => {
        if (url.startsWith("https://sts.googleapis.com/")) {
          return Response.json({ access_token: "federated" });
        }
        if (url.startsWith("https://iamcredentials.googleapis.com/") && !url.startsWith(prefix)) {
          return Response.json({ accessToken: "impersonated", expireTime: "2026-12-01T10:00:00Z" });
        }
        return url.startsWith(prefix) ? Response.json({}, { status }) : Response.json({});
      });
      const files = {
        "state.json": JSON.stringify({
          version: 1,
          scans: [
            {
              id: "scan-1",
              cloud: "gcp",
              scope: "farside-test",
              status: "succeeded",
              finishedAt: null,
              source: "live",
            },
          ],
          inventories: {},
          costs: {},
        }),
        "issues.json": "[]",
        "findings.json": "[]",
      };
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, name), text);
      }
      expect(await run()).toBe(EXIT_FAILED);
      expect(io.out()).toBe("");
      expect(io.err()).toContain(errorName);
      for (const [name, text] of Object.entries(files)) {
        expect(readFileSync(join(dir, name), "utf8")).toBe(text);
      }
    },
  );

  it("names invalid GCP settings with a fixed message, not an opaque failure", async () => {
    const io = capture();
    const code = await runCli(
      ["scan", "--cloud", "gcp", "--scope", "farside-test", "--workspace", tmp("farside-cli-ws-")],
      {
        ...io,
        env: { ...gcpEnv, FARSIDE_GCP_PROJECT_ID: "Bad_Project!" },
        clock,
        liveDeps: { fetch: async () => Response.json({}), readFile: async () => "x" },
      },
    );
    expect(code).toBe(EXIT_FAILED);
    expect(io.err()).toContain("FARSIDE_GCP_PROJECT_ID");
    expect(io.err()).not.toContain("live_setup");
    expect(io.err()).not.toContain("Bad_Project!");
  });
});

describe("farside CLI: fixture and live scans never share a workspace", () => {
  const SCOPE_ARGS = ["--cloud", "azure", "--scope", SUBSCRIPTION];

  it("refuses a live scan into a workspace that holds a fixture scan, and leaves it untouched", async () => {
    const dir = tmp("farside-cli-ws-");
    const fixture = capture();
    expect(
      await runCli(["scan", ...SCOPE_ARGS, "--fixture", "--workspace", dir], { ...fixture, clock }),
    ).toBe(EXIT_OK);
    const before = readFileSync(join(dir, "state.json"), "utf8");
    expect(
      JSON.parse(before).scans.every((scan: { source?: string }) => scan.source === undefined),
    ).toBe(true);

    const azure = fakeAzure({ now: () => new Date(NOW) });
    const live = capture();
    const code = await runCli(["scan", ...SCOPE_ARGS, "--workspace", dir], {
      ...live,
      env: azureEnv(),
      clock,
      liveDeps: { fetch: azure.fetch },
    });
    expect(code).toBe(EXIT_FAILED);
    expect(live.err()).toContain("holds fixture scans");
    expect(azure.calls).toEqual([]);
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before);
  });

  it("refuses a fixture scan into a workspace that holds a live scan, and keeps the real issues open", async () => {
    const { azure, dir, run } = azureScan();
    expect(await run()).toBe(EXIT_OK);
    expect(
      JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).scans.map(
        (scan: { source?: string }) => scan.source,
      ),
    ).toEqual(["live"]);
    const before = {
      state: readFileSync(join(dir, "state.json"), "utf8"),
      issues: readFileSync(join(dir, "issues.json"), "utf8"),
    };
    const fixture = capture();
    expect(
      await runCli(["scan", ...SCOPE_ARGS, "--fixture", "--workspace", dir], { ...fixture, clock }),
    ).toBe(EXIT_FAILED);
    expect(fixture.err()).toContain("holds live scans");
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before.state);
    expect(readFileSync(join(dir, "issues.json"), "utf8")).toBe(before.issues);
    expect(azure.tokensIssued()).toBeGreaterThan(0);
  });

  it("allows a second live scan into a live workspace", async () => {
    const { dir, run } = azureScan();
    expect(await run()).toBe(EXIT_OK);
    expect(await run()).toBe(EXIT_OK);
    expect(
      JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).scans.map(
        (scan: { source?: string }) => scan.source,
      ),
    ).toEqual(["live", "live"]);
  });
});

describe("farside CLI: the switches change nothing unless a live scan is asked for", () => {
  it("a fixture scan with a switch set makes no network call and keeps the fixture path", async () => {
    let calls = 0;
    const io = capture();
    const code = await runCli(
      [
        "scan",
        "--cloud",
        "azure",
        "--scope",
        SUBSCRIPTION,
        "--fixture",
        "--workspace",
        tmp("farside-cli-ws-"),
      ],
      {
        ...io,
        env: azureEnv(),
        clock,
        liveDeps: {
          fetch: async () => {
            calls += 1;
            return Response.json({});
          },
        },
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(calls).toBe(0);
    expect(JSON.parse(io.out())).toMatchObject({ status: "succeeded" });
  });

  it("a scan with no switch and no --fixture prints exactly the lines it printed before, and no live output", async () => {
    const io = capture();
    const code = await runCli(
      ["scan", "--cloud", "azure", "--scope", SUBSCRIPTION, "--workspace", tmp("farside-cli-ws-")],
      {
        ...io,
        env: {},
        clock,
        probe: () => ({ present: true, source: "environment" }),
      },
    );
    expect(code).toBe(EXIT_FAILED);
    const lines = io.err().split("\n").filter(Boolean);
    expect(lines.at(-1)).toBe("No cloud provider is configured");
    expect(lines.slice(0, -1).every((line) => line.startsWith('{"missingRoles"'))).toBe(true);
    expect(io.err()).not.toContain("failed");
    expect(io.err()).not.toContain("live_setup");
  });

  it("an Azure scope that is not a subscription id gets a fixed message", async () => {
    const io = capture();
    const code = await runCli(
      ["scan", "--cloud", "azure", "--scope", "not-a-guid", "--workspace", tmp("farside-cli-ws-")],
      {
        ...io,
        env: azureEnv(),
        clock,
        liveDeps: { fetch: async () => Response.json({}) },
      },
    );
    expect(code).toBe(EXIT_FAILED);
    expect(io.err()).toContain("subscription id");
    expect(io.err()).not.toContain("live_setup");
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
