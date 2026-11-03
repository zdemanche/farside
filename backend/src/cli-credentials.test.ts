import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checksForRole,
  isTokenFlag,
  missingRoles,
  probeLocalCredentials,
  TOKEN_FLAG_MESSAGE,
} from "./cli-credentials.js";
import { REQUIRED_AZURE_ROLES } from "./roles.js";

describe("cli credentials", () => {
  it("refuses token flags", () => {
    expect(isTokenFlag("token")).toBe(true);
    expect(isTokenFlag("client-secret")).toBe(true);
    expect(isTokenFlag("access_token")).toBe(true);
    expect(isTokenFlag("cloud")).toBe(false);
    expect(TOKEN_FLAG_MESSAGE).toMatch(/DefaultAzureCredential/);
  });

  it("maps missing Azure roles onto the checks they block", () => {
    const gaps = missingRoles("azure", ["Reader"]);
    expect(gaps.some((gap) => gap.role === "Reader")).toBe(false);
    const cost = gaps.find((gap) => gap.role === "Cost Management Reader");
    expect(cost?.required).toBe(true);
    expect(cost?.blockedCheckIds).toEqual(expect.arrayContaining(["azure-cost-spend-by-service"]));
    const backup = gaps.find((gap) => gap.role === "Backup Reader");
    expect(backup?.required).toBe(false);
    expect(backup?.blockedCheckIds).toEqual(
      expect.arrayContaining(["azure-resilience-prod-vms-outside-backup"]),
    );
    expect(REQUIRED_AZURE_ROLES.every((role) => role === "Reader" || gaps.some((gap) => gap.role === role))).toBe(
      true,
    );
    expect(checksForRole("azure", "Reservations Reader")).toEqual(
      expect.arrayContaining(["azure-cost-reservation-use"]),
    );
  });

  it("probes Azure CLI login first and refuses client secrets", () => {
    const home = mkdtempSync(join(tmpdir(), "farside-az-"));
    mkdirSync(join(home, ".azure"));
    expect(probeLocalCredentials("azure", { HOME: home }, home)).toEqual({
      present: true,
      source: "azure-cli",
    });
    expect(
      probeLocalCredentials("azure", { HOME: home, AZURE_CLIENT_SECRET: "s3cret-value-not-for-files" }, home).present,
    ).toBe(false);
    expect(probeLocalCredentials("azure", { AZURE_CLIENT_ID: "app-id" }, mkdtempSync(join(tmpdir(), "farside-empty-")))).toEqual({
      present: true,
      source: "azure-adc",
    });
  });

  it("probes GCP ADC by path existence without reading the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "farside-gcp-adc-"));
    const adc = join(dir, "adc.json");
    writeFileSync(adc, JSON.stringify({ client_secret: "ya29.this-is-not-copied" }));
    expect(probeLocalCredentials("gcp", { GOOGLE_APPLICATION_CREDENTIALS: adc }, dir)).toEqual({
      present: true,
      source: "gcp-adc",
    });
  });
});
