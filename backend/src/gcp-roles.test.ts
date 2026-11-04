import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import spec from "../../docs/gcp/launch-checks.json" with { type: "json" };
import "./providers/index.js";
import { gcpProvider } from "./providers/gcp.js";
import { probeRoles } from "./role-probe.js";

const specRoles = spec.rolesFromProposal;

describe("GCP roles", () => {
  it("are exactly the roles the launch-check spec names", () => {
    const named = [...gcpProvider.requiredRoles, ...gcpProvider.optionalRoles];
    expect([...named].sort()).toEqual([...specRoles].sort());
  });

  it("report each missing required role and flag the connection unhealthy", () => {
    const probe = probeRoles("gcp", ["Compute Viewer"]);
    expect(probe.healthy).toBe(false);
    expect(probe.missingRoles.map((gap) => gap.role)).toContain("Cloud SQL Viewer");
  });

  it("treat the billing export access as optional so cost checks degrade, not the connection", () => {
    const probe = probeRoles("gcp", gcpProvider.requiredRoles);
    expect(probe.healthy).toBe(true);
    expect(probe.missingRoles.some((gap) => !gap.required)).toBe(true);
  });

  it("match the role names the console Connect screen lists", () => {
    const consoleSource = readFileSync(
      new URL("../../console/src/connect-data.ts", import.meta.url),
      "utf8",
    );
    for (const role of specRoles) {
      expect(consoleSource).toContain(`"${role}"`);
    }
  });
});
