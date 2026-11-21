import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { FederatedExchangeError } from "./azure-federated.js";
import { AzureAccessDeniedError } from "./azure-live.js";
import { harvestLiveSubscription } from "./azure-live-harvest.js";
import { harvestCloudAssets, type CloudAssetClient } from "./cloud-asset.js";
import { GcpFederationError } from "./gcp-federation.js";
import { liveGcpHarvester } from "./gcp-live-harvester.js";
import { ResourceGraphFailedCallError } from "./resource-graph.js";
import { ScanFailedError } from "./scans.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const SUBSCRIPTION = "00000000-0000-0000-0000-000000000001";
const OBSERVED_AT = "2026-11-18T00:00:00.000Z";

function failure(arm: Parameters<typeof harvestLiveSubscription>[0]["arm"]): Promise<unknown> {
  return harvestLiveSubscription({
    arm,
    subscriptionId: SUBSCRIPTION,
    settings: DEFAULT_SETTINGS,
    observedAt: OBSERVED_AT,
  }).then(
    () => {
      throw new Error("expected the harvest to fail");
    },
    (error: unknown) => error,
  );
}

function logLine(error: unknown): string {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  pino({ level: "info" }, stream).error({ event: "scan.failed", err: error }, "scan.failed");
  return lines.join("");
}

describe("Azure: the real harvest keeps the cause behind a failed Resource Graph call", () => {
  it("chains a refused federation through ScanFailedError, and it reaches the scan.failed line", async () => {
    const refused = new FederatedExchangeError(401, "AADSTS70021");
    const error = await failure({
      token: async () => {
        throw refused;
      },
    });
    expect(error).toBeInstanceOf(ScanFailedError);
    const graph = (error as ScanFailedError).cause;
    expect(graph).toBeInstanceOf(ResourceGraphFailedCallError);
    expect((graph as Error).cause).toBe(refused);
    const line = logLine(error);
    expect(line).toContain("AADSTS70021");
    expect(line).toContain("FederatedExchangeError");
  });

  it("chains a 403 from ARM as a missing role, not as a generic failure", async () => {
    const error = await failure({
      token: async () => "test-token",
      fetch: async () => new Response("{}", { status: 403 }),
    });
    expect(error).toBeInstanceOf(ScanFailedError);
    const cause = ((error as ScanFailedError).cause as Error).cause;
    expect(cause).toBeInstanceOf(AzureAccessDeniedError);
    expect((cause as AzureAccessDeniedError).status).toBe(403);
  });

  it("puts no token, header or body text on the log line", async () => {
    const error = await failure({
      token: async () => {
        throw new FederatedExchangeError(401, "AADSTS70021");
      },
    });
    const line = logLine(error);
    for (const secret of ["Bearer", "client_assertion", "access_token", "authorization"]) {
      expect(line.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("keeps the old message and has no cause when none is given", () => {
    const error = new ResourceGraphFailedCallError();
    expect(error.message).toBe("Resource Graph call failed");
    expect(error.cause).toBeUndefined();
    expect(new ScanFailedError("m", []).cause).toBeUndefined();
  });
});

describe("GCP: a refused federation is logged with its safe cause", () => {
  const refusing: CloudAssetClient = {
    list: async () => {
      throw new GcpFederationError("sts", 400);
    },
  };

  it("still returns an empty undetermined harvest, and reports why", async () => {
    const log = vi.fn();
    const harvester = liveGcpHarvester({ cloudAsset: refusing } as never, () => OBSERVED_AT, log);
    const result = await harvester.harvest({
      orgId: "o",
      subscriptionId: "farside-test",
      settings: DEFAULT_SETTINGS,
    });
    expect(result.inventory.resources).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toEqual({
      event: "gcp.harvest.failed",
      projectId: "farside-test",
      reason: "failed_call",
      name: "GcpFederationError",
      status: 400,
      step: "sts",
    });
  });

  it("does not call the logger when the read succeeds", async () => {
    const log = vi.fn();
    const ok: CloudAssetClient = { list: async () => ({ assets: [] }) };
    const harvester = liveGcpHarvester(
      {
        cloudAsset: ok,
        serviceReads: {
          listSqlInstances: async () => [],
          listGkeClusters: async () => [],
          listCertificates: async () => [],
        },
        recommender: { list: async () => [] },
      } as never,
      () => OBSERVED_AT,
      log,
    );
    await harvester.harvest({
      orgId: "o",
      subscriptionId: "farside-test",
      settings: DEFAULT_SETTINGS,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("reports no cause from the Cloud Asset read itself when it succeeds", async () => {
    const ok: CloudAssetClient = { list: async () => ({ assets: [] }) };
    const result = await harvestCloudAssets({ client: ok, projectId: "farside-test" });
    expect(result.ok).toBe(true);
    expect(result.cause).toBeUndefined();
  });
});
