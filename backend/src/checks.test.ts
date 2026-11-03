import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RAW_PROVIDER_KEYS, scoreHealth, validateFinding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import {
  ALL_RESOURCES,
  ARG_CLOSER,
  CHECK_REGISTRY,
  EMPTY_PLANS,
  HARVEST_DRIVEN_CHECK_IDS,
  IDLE_LOAD_BALANCERS,
  DB_ZONE_OR_GEO,
  EXPIRING_APP_CERTS,
  EXPIRING_GATEWAY_CERTS,
  IDLE_NAT_GATEWAYS,
  NO_OWNER_TAG,
  OWNER_TAG_CLOSER,
  RETIRING_SKUS,
  OLD_SNAPSHOTS,
  PROD_SQL_BACKUP,
  PROD_VM_BACKUP,
  STOPPED_VMS,
  TAGS_CLOSER,
  UNASSOCIATED_IPS,
  UNATTACHED_DISKS,
  UnregisteredCheckError,
  acceptFinding,
  checkAllResources,
  checkEmptyPlans,
  checkIdleLoadBalancers,
  checkDbZoneOrGeo,
  checkExpiringAppCerts,
  checkExpiringGatewayCerts,
  checkIdleNatGateways,
  checkNoOwnerTag,
  checkRetiringSkus,
  checkOldSnapshots,
  checkProdSqlBackup,
  checkProdVmBackup,
  checkStoppedVms,
  checkUnassociatedIps,
  checkUnattachedDisks,
  runChecks,
} from "./checks.js";
import { AZURE_LAUNCH_CHECK_IDS, blindSpots, toContractCoverage } from "./coverage.js";
import { factsFromManifest } from "./facts.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import {
  DISK_SAVINGS_BASIS,
  EMPTY_PLAN_SAVINGS_BASIS,
  IDLE_LB_SAVINGS_BASIS,
  IDLE_NAT_SAVINGS_BASIS,
  PUBLIC_IP_SAVINGS_BASIS,
  SNAPSHOT_SAVINGS_BASIS,
  STOPPED_VM_SAVINGS_BASIS,
} from "./savings.js";
import { defaultHarvester } from "./scans.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const inventory = inventoryFromManifest(MANIFEST);
const facts = factsFromManifest(MANIFEST);
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("check registry and rules", () => {
  it("refuses an unregistered check", () => {
    expect(() =>
      runChecks({ inventory, facts, checkIds: ["azure-not-a-registered-check"] }),
    ).toThrow(UnregisteredCheckError);
  });

  it("registers every Azure launch check as a CheckFn or harvest-driven", () => {
    const harvestDriven = new Set<string>(HARVEST_DRIVEN_CHECK_IDS);
    expect(
      AZURE_LAUNCH_CHECK_IDS.every((checkId) => checkId in CHECK_REGISTRY || harvestDriven.has(checkId)),
    ).toBe(true);
  });

  it("emits inventory findings and undetermined paths", () => {
    const counted = checkAllResources(inventory, facts);
    expect(counted[0]?.checkId).toBe(ALL_RESOURCES);
    expect(counted[0]?.result).toBe("pass");
    expect(counted[0]?.evidence.fields.resourceCount).toBe(inventory.resources.length);
    expect(String(counted[0]?.evidence.fields.countByType)).toContain("Microsoft.Compute/disks:");
    const incomplete = checkAllResources(inventory, [
      {
        resourceUri: "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/x",
        fields: { argIncomplete: true },
      },
    ]);
    expect(incomplete[0]).toMatchObject({ result: "undetermined", closer: ARG_CLOSER });
    const untagged = checkNoOwnerTag(inventory, facts);
    expect(untagged[0]?.checkId).toBe(NO_OWNER_TAG);
    expect(untagged.find((finding) => finding.evidence.fields.resourceId?.toString().includes("disk-unattached"))?.result).toBe(
      "fail",
    );
    expect(untagged.filter((finding) => finding.result === "pass").length).toBeGreaterThan(0);
    const noKey = checkNoOwnerTag(inventory, facts, { ...DEFAULT_SETTINGS, ownerTagKey: "" });
    expect(noKey[0]).toMatchObject({ result: "undetermined", closer: OWNER_TAG_CLOSER });
    const noTags = checkNoOwnerTag(inventory, [
      {
        resourceUri: inventory.resources[0]?.resourceUri ?? "",
        fields: { tagsPresent: false },
      },
    ]);
    expect(noTags[0]).toMatchObject({ result: "undetermined", closer: TAGS_CLOSER });
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

describe("empty App Service plan check", () => {
  it("fails the seeded empty plan and passes the plan with a site", () => {
    const findings = checkEmptyPlans(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.checkId).toBe(EMPTY_PLANS);
    expect(fail?.evidence.fields.planId).toBe("plan-empty");
    expect(fail?.evidence.fields.numberOfSites).toBe(0);
    expect(fail?.savings).toEqual({ min: "70.00", max: "105.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(EMPTY_PLAN_SAVINGS_BASIS);
    expect(pass?.evidence.fields.planId).toBe("plan-with-site");
    expect(validateFinding(fail!)).toEqual([]);
  });

  it("returns undetermined when numberOfSites cannot be read", () => {
    const uri = inventory.resources.find((row) => row.displayName.includes("no sites"))!.resourceUri;
    const findings = checkEmptyPlans(inventory, [{ resourceUri: uri, fields: { planId: "plan-empty" } }]);
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toMatch(/numberOfSites/);
  });
});

describe("idle load balancer check", () => {
  it("fails the seeded idle balancer and passes the busy lookalike", () => {
    const findings = checkIdleLoadBalancers(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.checkId).toBe(IDLE_LOAD_BALANCERS);
    expect(fail?.evidence.fields.loadBalancerId).toBe("lb-idle");
    expect(fail?.evidence.fields.backendAddressCount).toBe(0);
    expect(fail?.evidence.fields.metricWindow).toBe("7d");
    expect(fail?.savings).toEqual({ min: "18.00", max: "27.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(IDLE_LB_SAVINGS_BASIS);
    expect(JSON.stringify(fail)).not.toMatch(/confirmed idle/i);
    expect(pass?.evidence.fields.loadBalancerId).toBe("lb-busy");
    expect(pass?.evidence.fields.backendAddressCount).toBe(2);
    expect(validateFinding(fail!)).toEqual([]);
  });

  it("returns undetermined when backend pools cannot be read", () => {
    const uri = inventory.resources.find((row) => row.displayName.includes("no backend addresses"))!.resourceUri;
    const findings = checkIdleLoadBalancers(inventory, [
      { resourceUri: uri, fields: { loadBalancerId: "lb-idle" } },
    ]);
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toMatch(/backend address pools/);
  });
});

describe("idle NAT gateway check", () => {
  it("fails the seeded idle NAT and passes the attached lookalike", () => {
    const findings = checkIdleNatGateways(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.checkId).toBe(IDLE_NAT_GATEWAYS);
    expect(fail?.evidence.fields.natGatewayId).toBe("nat-idle");
    expect(fail?.evidence.fields.attachedSubnetCount).toBe(0);
    expect(fail?.evidence.fields.metricWindow).toBe("7d");
    expect(fail?.savings).toEqual({ min: "32.00", max: "48.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(IDLE_NAT_SAVINGS_BASIS);
    expect(JSON.stringify(fail)).not.toMatch(/confirmed idle/i);
    expect(pass?.evidence.fields.natGatewayId).toBe("nat-attached");
    expect(validateFinding(fail!)).toEqual([]);
  });

  it("returns undetermined when subnet associations cannot be read", () => {
    const uri = inventory.resources.find((row) => row.displayName.includes("no subnets"))!.resourceUri;
    const findings = checkIdleNatGateways(inventory, [
      { resourceUri: uri, fields: { natGatewayId: "nat-idle" } },
    ]);
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toMatch(/subnets/);
  });
});

describe("missing metrics undetermined path", () => {
  it("returns undetermined when traffic metrics are removed", () => {
    const stripped = facts.map((row) => {
      if (row.fields.loadBalancerId !== "lb-idle" && row.fields.natGatewayId !== "nat-idle") {
        return row;
      }
      const fields = { ...row.fields };
      delete fields.metricWindow;
      delete fields.byteCount;
      return { ...row, fields };
    });
    const lb = checkIdleLoadBalancers(inventory, stripped).find(
      (finding) => finding.evidence.fields.loadBalancerId === "lb-idle",
    );
    const nat = checkIdleNatGateways(inventory, stripped).find(
      (finding) => finding.evidence.fields.natGatewayId === "nat-idle",
    );
    expect(lb?.result).toBe("undetermined");
    expect(lb?.closer).toMatch(/Monitoring Reader/);
    expect(lb?.closer).toMatch(/longer window/);
    expect(nat?.result).toBe("undetermined");
    expect(nat?.closer).toMatch(/Monitoring Reader/);
    expect(JSON.stringify(lb)).not.toMatch(/confirmed idle/i);
  });
});

describe("scope coverage from determinate results", () => {
  it("marks a scope undetermined with the closer when no finding is pass or fail", () => {
    const blind = runChecks({ inventory, facts: [], checkIds: [UNATTACHED_DISKS] });
    const entry = blind.coverage.find((item) => item.subscriptionOrProject === "main");
    expect(entry).toMatchObject({ state: "undetermined", closer: expect.stringMatching(/diskState/) });
    expect(blindSpots(blind.coverage).some((spot) => spot.id === entry?.id)).toBe(true);
  });

  it("keeps a scope assessed when at least one result is determinate", () => {
    const sighted = runChecks({ inventory, facts, checkIds: [UNATTACHED_DISKS] });
    expect(sighted.coverage.find((item) => item.subscriptionOrProject === "main")?.state).toBe("assessed");
  });
});

describe("production backup coverage", () => {
  it("fails unprotected production VMs and SQL as N of M and passes protected lookalikes", () => {
    const vms = checkProdVmBackup(inventory, facts, DEFAULT_SETTINGS);
    const sql = checkProdSqlBackup(inventory, facts, DEFAULT_SETTINGS);
    const vmFail = vms.find((finding) => finding.result === "fail");
    const sqlFail = sql.find((finding) => finding.result === "fail");
    expect(vmFail?.checkId).toBe(PROD_VM_BACKUP);
    expect(vmFail?.evidence.fields.vmId).toBe("vm-prod-no-backup");
    expect(vmFail?.evidence.fields.protected).toBe(false);
    expect(vmFail?.evidence.fields.productionMarker).toBe("environment=prod");
    expect(vmFail?.evidence.fields.unprotectedCount).toBe(1);
    expect(vmFail?.evidence.fields.productionCount).toBe(2);
    expect(vms.find((finding) => finding.evidence.fields.vmId === "vm-prod-backed-up")?.result).toBe(
      "pass",
    );
    expect(vms.some((finding) => finding.evidence.fields.vmId === "vm-deallocated")).toBe(false);
    expect(sqlFail?.checkId).toBe(PROD_SQL_BACKUP);
    expect(sqlFail?.evidence.fields.sqlResourceId).toBe("sql-prod-no-backup");
    expect(sqlFail?.evidence.fields.unprotectedCount).toBe(1);
    expect(sqlFail?.evidence.fields.productionCount).toBe(2);
    expect(sql.find((finding) => finding.evidence.fields.sqlResourceId === "sql-prod-backed-up")?.result).toBe(
      "pass",
    );
    expect(validateFinding(vmFail!)).toEqual([]);
    expect(validateFinding(sqlFail!)).toEqual([]);
  });

  it("is undetermined when the production marker or Backup Reader evidence is removed", () => {
    const noMarker = checkProdVmBackup(inventory, facts, {
      ...DEFAULT_SETTINGS,
      productionTagKey: "",
      productionTagValue: "",
    });
    expect(noMarker.every((finding) => finding.result === "undetermined")).toBe(true);
    expect(noMarker[0]?.closer).toMatch(/production tag or name pattern/);
    expect(noMarker.some((finding) => finding.evidence.fields.productionCount != null)).toBe(false);
    const noRole = checkProdSqlBackup(
      inventory,
      facts.map((row) =>
        row.fields.sqlResourceId === "sql-prod-no-backup"
          ? { ...row, fields: { sqlResourceId: "sql-prod-no-backup" } }
          : row,
      ),
    );
    const missing = noRole.find((finding) => finding.evidence.fields.sqlResourceId === "sql-prod-no-backup");
    expect(missing?.result).toBe("undetermined");
    expect(missing?.closer).toMatch(/Backup Reader/);
  });
});

describe("database zone and geo-backup check", () => {
  it("fails the seeded database missing zone or geo and passes the redundant lookalike", () => {
    const findings = checkDbZoneOrGeo(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.checkId).toBe(DB_ZONE_OR_GEO);
    expect(fail?.evidence.fields.databaseId).toBe("db-no-zone-geo");
    expect(fail?.evidence.fields.missingSetting).toBe("zone redundancy and geo-backup");
    expect(pass?.evidence.fields.databaseId).toBe("db-zone-geo");
    expect(validateFinding(fail!)).toEqual([]);
  });

  it("returns undetermined when redundancy properties cannot be read", () => {
    const uri = inventory.resources.find((row) => row.displayName.includes("without zone"))!.resourceUri;
    const findings = checkDbZoneOrGeo(inventory, [
      { resourceUri: uri, fields: { databaseId: "db-no-zone-geo", engine: "sql" } },
    ]);
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toMatch(/those properties/);
  });
});

describe("retiring SKU check", () => {
  it("fails the seeded retiring SKU with the catalogue date and passes a SKU not listed", () => {
    const findings = checkRetiringSkus(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.evidence.fields.resourceId === "vm-deallocated");
    expect(fail?.checkId).toBe(RETIRING_SKUS);
    expect(fail?.evidence.fields.resourceId).toBe("vm-retiring-sku");
    expect(fail?.evidence.fields.skuName).toBe("Standard_B1ls");
    expect(fail?.evidence.fields.retirementDate).toBe("2026-12-31");
    expect(fail?.evidence.fields.source).toBe("docs/azure/retiring-skus.json");
    expect(pass?.result).toBe("pass");
    expect(pass?.evidence.fields.catalogueVersion).toBe(1);
    expect(pass?.evidence.fields.cataloguePublishedAt).toBe("2026-11-02");
    expect(validateFinding(fail!)).toEqual([]);
  });
});

describe("certificate expiry checks", () => {
  it("fails seeded certs inside the warning window and passes fresh lookalikes", () => {
    const apps = checkExpiringAppCerts(inventory, facts, DEFAULT_SETTINGS);
    const gateways = checkExpiringGatewayCerts(inventory, facts, DEFAULT_SETTINGS);
    const appFail = apps.find((finding) => finding.result === "fail");
    const gatewayFail = gateways.find((finding) => finding.result === "fail");
    expect(appFail?.checkId).toBe(EXPIRING_APP_CERTS);
    expect(appFail?.evidence.fields.certificateId).toBe("cert-app-expiring");
    expect(appFail?.evidence.fields.expirationDate).toBe("2026-11-22");
    expect(appFail?.evidence.fields.daysRemaining).toBe(20);
    expect(apps.find((finding) => finding.evidence.fields.certificateId === "cert-app-fresh")?.result).toBe(
      "pass",
    );
    expect(gatewayFail?.checkId).toBe(EXPIRING_GATEWAY_CERTS);
    expect(gatewayFail?.evidence.fields.gatewayId).toBe("cert-gateway-expiring");
    expect(gatewayFail?.evidence.fields.expirationDate).toBe("2026-11-22");
    expect(
      gateways.find((finding) => finding.evidence.fields.gatewayId === "cert-gateway-fresh")?.result,
    ).toBe("pass");
    expect(validateFinding(appFail!)).toEqual([]);
  });

  it("returns undetermined when the certificate cannot be read", () => {
    const uri = inventory.resources.find((row) => row.displayName.includes("App Service certificate inside"))!
      .resourceUri;
    const findings = checkExpiringAppCerts(inventory, [
      { resourceUri: uri, fields: { certificateId: "cert-app-expiring" } },
    ]);
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toMatch(/expirationDate/);
  });
});

describe("unattached disk harvest to API", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, { ...TEST_APP_OPTIONS, harvester: defaultHarvester() });

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
    let findings: Array<{
      result: string;
      checkId?: string;
      evidence: { fields: Record<string, unknown> };
    }> = [];
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
    const plan = findings.find((finding) => finding.evidence.fields.planId === "plan-empty");
    const lb = findings.find((finding) => finding.evidence.fields.loadBalancerId === "lb-idle");
    const nat = findings.find((finding) => finding.evidence.fields.natGatewayId === "nat-idle");
    expect(plan?.result).toBe("fail");
    expect(plan?.evidence.fields.numberOfSites).toBe(0);
    expect(lb?.result).toBe("fail");
    expect(lb?.evidence.fields.metricWindow).toBe("7d");
    expect(nat?.result).toBe("fail");
    expect(findings.some((finding) => finding.evidence.fields.planId === "plan-with-site" && finding.result === "fail")).toBe(
      false,
    );
    expect(findings.some((finding) => finding.evidence.fields.loadBalancerId === "lb-busy" && finding.result === "fail")).toBe(
      false,
    );
    expect(findings.some((finding) => finding.evidence.fields.natGatewayId === "nat-attached" && finding.result === "fail")).toBe(
      false,
    );
    const prodVm = findings.find(
      (finding) =>
        finding.evidence.fields.vmId === "vm-prod-no-backup" &&
        finding.checkId === "azure-resilience-prod-vms-outside-backup",
    );
    const prodSql = findings.find(
      (finding) => finding.evidence.fields.sqlResourceId === "sql-prod-no-backup",
    );
    const db = findings.find((finding) => finding.evidence.fields.databaseId === "db-no-zone-geo");
    expect(prodVm?.result).toBe("fail");
    expect(prodVm?.evidence.fields.unprotectedCount).toBe(1);
    expect(prodVm?.evidence.fields.productionCount).toBe(2);
    expect(prodSql?.result).toBe("fail");
    expect(db?.result).toBe("fail");
    expect(db?.evidence.fields.missingSetting).toBe("zone redundancy and geo-backup");
    expect(
      findings.some((finding) => finding.evidence.fields.vmId === "vm-prod-backed-up" && finding.result === "fail"),
    ).toBe(false);
    const retiring = findings.find((finding) => finding.evidence.fields.resourceId === "vm-retiring-sku");
    const appCert = findings.find((finding) => finding.evidence.fields.certificateId === "cert-app-expiring");
    const gatewayCert = findings.find((finding) => finding.evidence.fields.gatewayId === "cert-gateway-expiring");
    expect(retiring?.result).toBe("fail");
    expect(retiring?.evidence.fields.retirementDate).toBe("2026-12-31");
    expect(appCert?.result).toBe("fail");
    expect(gatewayCert?.result).toBe("fail");
  });
});

describe("snapshot retention from settings", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, { ...TEST_APP_OPTIONS, harvester: defaultHarvester() });

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
    let findings: Array<{
      result: string;
      checkId?: string;
      evidence: { fields: Record<string, unknown> };
    }> = [];
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
