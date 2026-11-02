import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RAW_PROVIDER_KEYS, scoreHealth, validateFinding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import {
  OLD_SNAPSHOTS,
  STOPPED_VMS,
  UNASSOCIATED_IPS,
  UNATTACHED_DISKS,
  UnregisteredCheckError,
  acceptFinding,
  checkOldSnapshots,
  checkStoppedVms,
  checkUnassociatedIps,
  checkUnattachedDisks,
  runChecks,
} from "./checks.js";
import { toContractCoverage } from "./coverage.js";
import { factsFromManifest } from "./facts.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import {
  DISK_SAVINGS_BASIS,
  PUBLIC_IP_SAVINGS_BASIS,
  SNAPSHOT_SAVINGS_BASIS,
  STOPPED_VM_SAVINGS_BASIS,
} from "./savings.js";
import { defaultHarvester } from "./scans.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const inventory = inventoryFromManifest(MANIFEST);
const facts = factsFromManifest(MANIFEST);
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("check registry and rules", () => {
  it("refuses an unregistered check", () => {
    expect(() =>
      runChecks({ inventory, facts, checkIds: ["azure-waste-empty-app-service-plans"] }),
    ).toThrow(UnregisteredCheckError);
  });

  it("rejects findings without evidence and undetermined without a closer", () => {
    expect(() =>
      acceptFinding({
        checkId: UNATTACHED_DISKS,
        result: "fail",
        evidence: { fields: {} },
        scope: { id: "main:check", cloud: "azure", subscriptionOrProject: "main" },
      }),
    ).toThrow(/evidence/);
    expect(() =>
      acceptFinding({
        checkId: UNATTACHED_DISKS,
        result: "undetermined",
        evidence: { fields: { diskId: "x" } },
        scope: { id: "main:check", cloud: "azure", subscriptionOrProject: "main" },
      }),
    ).toThrow(/closer/);
  });

  it("marks unread subscriptions unassessed and leaves them out of the score", () => {
    const { findings, coverage } = runChecks({
      inventory,
      facts,
      checkIds: [UNATTACHED_DISKS],
      unreadSubscriptions: ["ghost"],
    });
    const health = scoreHealth(toContractCoverage(coverage), findings);
    const withoutGhost = runChecks({ inventory, facts, checkIds: [UNATTACHED_DISKS] });
    expect(scoreHealth(toContractCoverage(withoutGhost.coverage), withoutGhost.findings).score).toBe(
      health.score,
    );
    expect(coverage.some((entry) => entry.subscriptionOrProject === "ghost" && entry.state === "unassessed")).toBe(
      true,
    );
  });
});

describe("unattached disk check", () => {
  it("fails the seeded unattached disk and passes the attached lookalike", () => {
    const findings = checkUnattachedDisks(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.evidence.fields.diskId).toBe("disk-unattached");
    expect(fail?.evidence.fields.diskState).toBe("Unattached");
    expect(fail?.savings).toEqual({ min: "8.00", max: "12.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(DISK_SAVINGS_BASIS);
    expect(pass?.evidence.fields.diskId).toBe("disk-attached");
    expect(pass?.result).toBe("pass");
    expect(validateFinding(fail!)).toEqual([]);
    for (const key of RAW_PROVIDER_KEYS) {
      expect(JSON.stringify(findings)).not.toContain(key);
    }
  });

  it("returns undetermined when diskState is missing", () => {
    const findings = checkUnattachedDisks(inventory, [
      {
        resourceUri: inventory.resources.find((row) => row.displayName.includes("Unattached"))!.resourceUri,
        fields: { diskId: "disk-unattached", location: "eastus" },
      },
    ]);
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toMatch(/diskState/);
  });
});

describe("old snapshot check", () => {
  it("fails the seeded old snapshot and passes the fresh lookalike", () => {
    const findings = checkOldSnapshots(inventory, facts, DEFAULT_SETTINGS);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.checkId).toBe(OLD_SNAPSHOTS);
    expect(fail?.evidence.fields.snapshotId).toBe("snapshot-old");
    expect(fail?.evidence.fields.ageDays).toBe(90);
    expect(fail?.evidence.fields.retentionDays).toBe(30);
    expect(fail?.savings).toEqual({ min: "1.00", max: "3.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(SNAPSHOT_SAVINGS_BASIS);
    expect(pass?.evidence.fields.snapshotId).toBe("snapshot-fresh");
    expect(pass?.evidence.fields.retentionDays).toBe(30);
    expect(validateFinding(fail!)).toEqual([]);
    for (const key of RAW_PROVIDER_KEYS) {
      expect(JSON.stringify(findings)).not.toContain(key);
    }
  });

  it("uses the configured retention and is undetermined without age or threshold", () => {
    const generous = checkOldSnapshots(inventory, facts, {
      ...DEFAULT_SETTINGS,
      snapshotRetentionDays: 120,
    });
    expect(generous.every((finding) => finding.result === "pass")).toBe(true);
    const missingAge = checkOldSnapshots(
      inventory,
      facts.map((row) =>
        row.fields.snapshotId === "snapshot-old" ? { ...row, fields: { snapshotId: "snapshot-old" } } : row,
      ),
    );
    expect(missingAge.find((finding) => finding.evidence.fields.snapshotId === "snapshot-old")?.result).toBe(
      "undetermined",
    );
    const noThreshold = checkOldSnapshots(inventory, facts, {
      ...DEFAULT_SETTINGS,
      snapshotRetentionDays: 0,
    });
    expect(noThreshold[0]?.result).toBe("undetermined");
    expect(noThreshold[0]?.closer).toMatch(/Settings/);
    expect(noThreshold[0]?.evidence.fields.retentionDays).toBeNull();
  });
});

describe("unassociated public IP check", () => {
  it("fails the seeded unassociated IP and passes the associated lookalike", () => {
    const findings = checkUnassociatedIps(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.checkId).toBe(UNASSOCIATED_IPS);
    expect(fail?.evidence.fields.publicIpId).toBe("pip-unassociated");
    expect(fail?.evidence.fields.associatedTo).toBeNull();
    expect(fail?.savings).toEqual({ min: "3.00", max: "5.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(PUBLIC_IP_SAVINGS_BASIS);
    expect(pass?.evidence.fields.publicIpId).toBe("pip-associated");
    expect(validateFinding(fail!)).toEqual([]);
  });

  it("returns undetermined when association cannot be read", () => {
    const uri = inventory.resources.find((row) => row.displayName.includes("no ipConfiguration"))!.resourceUri;
    const findings = checkUnassociatedIps(inventory, [{ resourceUri: uri, fields: { publicIpId: "pip-unassociated" } }]);
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toMatch(/ipConfiguration/);
  });
});

describe("stopped-not-deallocated VM check", () => {
  it("fails the stopped allocated VM and passes deallocated and running lookalikes", () => {
    const findings = checkStoppedVms(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    expect(fail?.checkId).toBe(STOPPED_VMS);
    expect(fail?.evidence.fields.vmId).toBe("vm-stopped-allocated");
    expect(fail?.evidence.fields.powerState).toBe("stopped");
    expect(fail?.savings).toEqual({ min: "30.40", max: "45.60", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(STOPPED_VM_SAVINGS_BASIS);
    expect(
      findings.find((finding) => finding.evidence.fields.vmId === "vm-deallocated")?.result,
    ).toBe("pass");
    expect(
      findings.find((finding) => finding.evidence.fields.vmId === "vm-prod-no-backup")?.result,
    ).toBe("pass");
    expect(validateFinding(fail!)).toEqual([]);
  });

  it("returns undetermined when powerState cannot be read", () => {
    const uri = inventory.resources.find((row) => row.displayName.includes("still allocated"))!.resourceUri;
    const findings = checkStoppedVms(inventory, [{ resourceUri: uri, fields: { vmId: "vm-stopped-allocated" } }]);
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toMatch(/powerState/);
  });
});

describe("unattached disk harvest to API", () => {
  const store = new MemoryStore();
  const app = buildApp(store, { harvester: defaultHarvester() });

  afterAll(async () => {
    await app.close();
  });

  it("stores the finding from a scan and returns it with evidence", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });
    expect(created.statusCode).toBe(201);
    let findings: Array<{ result: string; evidence: { fields: Record<string, unknown> } }> = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/orgs/org-a/findings",
        headers: ORG,
      });
      findings = response.json().findings;
      if (findings.some((finding) => finding.result === "fail")) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const fail = findings.find((finding) => finding.evidence.fields.diskId === "disk-unattached");
    expect(fail?.result).toBe("fail");
    expect(fail?.evidence.fields.diskState).toBe("Unattached");
    expect(JSON.stringify(fail)).not.toMatch(/armBody|sdkResponse|"payload"/);
    const snapshot = findings.find((finding) => finding.evidence.fields.snapshotId === "snapshot-old");
    const ip = findings.find((finding) => finding.evidence.fields.publicIpId === "pip-unassociated");
    const vm = findings.find((finding) => finding.evidence.fields.vmId === "vm-stopped-allocated");
    expect(snapshot?.result).toBe("fail");
    expect(snapshot?.evidence.fields.retentionDays).toBe(30);
    expect(ip?.result).toBe("fail");
    expect(vm?.result).toBe("fail");
    expect(vm?.evidence.fields.powerState).toBe("stopped");
    expect(findings.some((finding) => finding.evidence.fields.vmId === "vm-deallocated" && finding.result === "fail")).toBe(
      false,
    );
  });
});

describe("snapshot retention from settings", () => {
  const store = new MemoryStore();
  const app = buildApp(store, { harvester: defaultHarvester() });

  afterAll(async () => {
    await app.close();
  });

  it("uses the configured retention on the next scan", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/settings",
      headers: ORG,
      payload: {
        ownerTagKey: "owner",
        productionTagKey: "environment",
        productionTagValue: "prod",
        snapshotRetentionDays: 120,
      },
    });
    expect(saved.statusCode).toBe(200);
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });
    expect(created.statusCode).toBe(201);
    let findings: Array<{ result: string; evidence: { fields: Record<string, unknown> } }> = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/orgs/org-a/findings",
        headers: ORG,
      });
      findings = response.json().findings;
      if (findings.some((finding) => finding.evidence.fields.snapshotId === "snapshot-old")) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const snapshot = findings.find((finding) => finding.evidence.fields.snapshotId === "snapshot-old");
    expect(snapshot?.result).toBe("pass");
    expect(snapshot?.evidence.fields.retentionDays).toBe(120);
  });
});
