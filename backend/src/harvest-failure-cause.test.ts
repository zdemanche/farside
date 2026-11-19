import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { FederatedExchangeError } from "./azure-federated.js";
import { harvestCloudAssets, type CloudAssetClient } from "./cloud-asset.js";
import { GcpFederationError } from "./gcp-federation.js";
import { liveGcpHarvester } from "./gcp-live-harvester.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { harvestResourceGraph, ResourceGraphFailedCallError } from "./resource-graph.js";
import { ScanFailedError } from "./scans.js";

describe("Azure: the cause behind a failed Resource Graph call is kept", () => {
  it("chains the original error on the failed-call error and the harvest result", async () => {
    const refused = new FederatedExchangeError(401, "AADSTS70021");
    const result = await harvestResourceGraph({
      client: {
        query: async () => {
          throw new ResourceGraphFailedCallError(refused);
        },
      },
      subscriptionId: "00000000-0000-0000-0000-000000000001",
      settings: DEFAULT_SETTINGS,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("failed_call");
    expect(result.cause).toBeInstanceOf(ResourceGraphFailedCallError);
    expect((result.cause as Error).cause).toBe(refused);
  });

  it("keeps the old message and no cause when none is given", () => {
    const error = new ResourceGraphFailedCallError();
    expect(error.message).toBe("Resource Graph call failed");
    expect(error.cause).toBeUndefined();
  });

  it("lets ScanFailedError carry a cause, and still works without one", () => {
    const cause = new Error("x");
    expect(new ScanFailedError("m", [], { cause }).cause).toBe(cause);
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
    const harvester = liveGcpHarvester(
      { cloudAsset: refusing } as never,
      () => "2026-11-18T00:00:00.000Z",
      log,
    );
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

  it("does not log, and does not need a logger, on success", async () => {
    const ok: CloudAssetClient = { list: async () => ({ assets: [] }) };
    const result = await harvestCloudAssets({ client: ok, projectId: "farside-test" });
    expect(result.ok).toBe(true);
    expect(result.cause).toBeUndefined();
  });
});

describe("the cause reaches the scan.failed log line", () => {
  it("serialises the Entra code and status through ScanFailedError, with no message text from Entra", () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ level: "info" }, stream);
    const error = new ScanFailedError("resource graph failed_call", [], {
      cause: new ResourceGraphFailedCallError(new FederatedExchangeError(401, "AADSTS70021")),
    });
    log.error({ event: "scan.failed", err: error }, "scan.failed");
    const line = lines.join("");
    expect(line).toContain("AADSTS70021");
    expect(line).toContain("FederatedExchangeError");
  });
});
