import { afterAll, describe, expect, it } from "vitest";
import { RAW_PROVIDER_KEYS, validateFinding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import { registeredCheckIds, runChecks, UnregisteredCheckError } from "./checks.js";
import {
  checkGcpUnattachedDisks,
  checkGcpUnusedIps,
  GCP_UNATTACHED_DISKS,
  GCP_UNUSED_IPS,
} from "./gcp-checks.js";
import { factsFromGcpManifest, inventoryFromGcpManifest, type GcpGroundTruthManifest } from "./gcp-inventory.js";
import { fixtureHarvester } from "./scans.js";
import { GCP_DISK_SAVINGS_BASIS, GCP_IP_SAVINGS_BASIS } from "./savings.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/gcp/ground-truth.json"), "utf8"),
) as GcpGroundTruthManifest;

const inventory = inventoryFromGcpManifest(MANIFEST);
const facts = factsFromGcpManifest(MANIFEST);
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("gcp waste registry", () => {
  it("registers only the implemented GCP waste checks and refuses spec ids without an impl", () => {
    expect(registeredCheckIds("gcp").sort()).toEqual([GCP_UNATTACHED_DISKS, GCP_UNUSED_IPS].sort());
    expect(registeredCheckIds("azure")).not.toContain(GCP_UNATTACHED_DISKS);
    expect(() => runChecks({ inventory, facts, checkIds: ["gcp-cost-spend-by-service"] })).toThrow(
      UnregisteredCheckError,
    );
  });
});

describe("gcp unattached disks", () => {
  it("fails disk-parked and passes disk-in-use against the fixture", () => {
    const findings = checkGcpUnattachedDisks(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.checkId).toBe(GCP_UNATTACHED_DISKS);
    expect(fail?.evidence.fields.diskId).toBe("disk-parked");
    expect(fail?.evidence.fields.usersCount).toBe(0);
    expect(fail?.evidence.fields.zone).toBe("us-central1-a");
    expect(fail?.scope.cloud).toBe("gcp");
    expect(fail?.scope.subscriptionOrProject).toBe("farside-test");
    expect(fail?.savings).toEqual({ min: "4.00", max: "6.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(GCP_DISK_SAVINGS_BASIS);
    expect(pass?.evidence.fields.diskId).toBe("disk-in-use");
    expect(pass?.evidence.fields.usersCount).toBe(1);
    expect(validateFinding(fail!)).toEqual([]);
    for (const key of RAW_PROVIDER_KEYS) {
      expect(JSON.stringify(findings)).not.toContain(key);
    }
  });

  it("returns undetermined when users is missing", () => {
    const parked = inventory.resources.find((row) => row.displayName.includes("Unattached"));
    expect(parked).toBeDefined();
    const findings = checkGcpUnattachedDisks(inventory, [
      { resourceUri: parked!.resourceUri, fields: { diskId: "disk-parked", location: "us-central1-a" } },
    ]);
    const undetermined = findings.find((finding) => finding.evidence.fields.diskId === "disk-parked");
    expect(undetermined?.result).toBe("undetermined");
    expect(undetermined?.closer).toMatch(/users list/);
  });
});

describe("gcp unused external ips", () => {
  it("fails addr-idle and passes addr-bound against the fixture", () => {
    const findings = checkGcpUnusedIps(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.checkId).toBe(GCP_UNUSED_IPS);
    expect(fail?.evidence.fields.addressId).toBe("addr-idle");
    expect(fail?.evidence.fields.status).toBe("RESERVED");
    expect(fail?.evidence.fields.usersCount).toBe(0);
    expect(fail?.savings).toEqual({ min: "2.50", max: "4.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(GCP_IP_SAVINGS_BASIS);
    expect(pass?.evidence.fields.addressId).toBe("addr-bound");
    expect(pass?.evidence.fields.status).toBe("IN_USE");
    expect(validateFinding(fail!)).toEqual([]);
  });

  it("returns undetermined when status or users is missing", () => {
    const idle = inventory.resources.find((row) => row.displayName.includes("Reserved unused"));
    expect(idle).toBeDefined();
    const findings = checkGcpUnusedIps(inventory, [
      { resourceUri: idle!.resourceUri, fields: { addressId: "addr-idle", location: "us-central1" } },
    ]);
    const undetermined = findings.find((finding) => finding.evidence.fields.addressId === "addr-idle");
    expect(undetermined?.result).toBe("undetermined");
    expect(undetermined?.closer).toMatch(/status and users/);
  });
});

describe("gcp waste scan", () => {
  const store = new MemoryStore();
  const app = buildApp(store, { harvester: fixtureHarvester(inventory, facts) });

  afterAll(async () => {
    await app.close();
  });

  it("stores fixture fail findings for the parked disk and reserved IP", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "farside-test" },
    });
    expect(started.statusCode).toBe(202);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (store.snapshot("org-a").findings.some((finding) => finding.checkId.startsWith("gcp-waste-"))) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const findings = store.snapshot("org-a").findings;
    expect(findings.some((finding) => finding.checkId === GCP_UNATTACHED_DISKS && finding.result === "fail")).toBe(
      true,
    );
    expect(findings.some((finding) => finding.checkId === GCP_UNUSED_IPS && finding.result === "fail")).toBe(true);
    expect(findings.every((finding) => !finding.checkId.startsWith("azure-"))).toBe(true);
    const { coverage } = runChecks({
      inventory,
      facts,
      checkIds: registeredCheckIds("gcp"),
    });
    expect(coverage.every((entry) => entry.subscriptionOrProject === "farside-test")).toBe(true);
  });
});
