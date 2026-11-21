import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "./gcp-live-run.js";

const ENV = {
  FARSIDE_GCP_LIVE: "1",
  FARSIDE_GCP_PROJECT_ID: "farside-test",
  FARSIDE_GCP_POOL_PROJECT_NUMBER: "123456789",
  FARSIDE_GCP_POOL_ID: "farside-pool",
  FARSIDE_GCP_PROVIDER_ID: "farside-aws",
  FARSIDE_GCP_SERVICE_ACCOUNT: "farside-reader@farside-test.iam.gserviceaccount.com",
  AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
};

describe("live GCP run reports why a harvest failed", () => {
  it("prints the federation step and status, and nothing from the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gcp-sink-"));
    const specPath = join(dir, "launch-checks.json");
    writeFileSync(
      specPath,
      readFileSync(new URL("../../docs/gcp/launch-checks.json", import.meta.url), "utf8"),
    );
    // Google STS refuses the exchange, as it does for a wrong pool id or a provider condition that excludes the role.
    const fetch = vi.fn(async () => Response.json({ error: "invalid_target" }, { status: 400 }));
    const out = vi.fn();
    await main({
      env: ENV,
      deps: {
        fetch,
        readFile: async () => "SECRET-OIDC-TOKEN",
        now: () => new Date("2026-12-01T10:00:00Z"),
      },
      out,
      dir,
      specPath,
      regenerate: vi.fn(),
    });
    const lines = out.mock.calls.map(([line]) => String(line));
    const reported = lines.find((line) => line.startsWith("gcp harvest failed"));
    expect(reported).toBeDefined();
    expect(JSON.parse((reported as string).slice("gcp harvest failed ".length))).toMatchObject({
      event: "gcp.harvest.failed",
      projectId: "farside-test",
      reason: "failed_call",
      name: "GcpFederationError",
      status: 400,
      step: "sts",
    });
    const everything = lines.join("\n");
    for (const secret of ["SECRET-OIDC-TOKEN", "invalid_target", "123456789", "farside-pool"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
