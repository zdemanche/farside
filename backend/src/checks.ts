import {
  assertValid,
  validateFinding,
  type Finding,
  type Inventory,
} from "@farside/scan-contracts";
import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import {
  checkGcpOldSnapshotsAndImages,
  checkGcpUnattachedDisks,
  checkGcpUnusedIps,
  GCP_OLD_SNAPSHOTS_AND_IMAGES,
  GCP_UNATTACHED_DISKS,
  GCP_UNUSED_IPS,
} from "./gcp-checks.js";
import { projectOf } from "./gcp-inventory.js";
import { loadRetiringSkus } from "./retiring.js";
import type { OrgSettings } from "./settings.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import {
  diskMonthlySavings,
  emptyPlanMonthlySavings,
  idleLbMonthlySavings,
  idleNatMonthlySavings,
  publicIpMonthlySavings,
  snapshotMonthlySavings,
  stoppedVmMonthlySavings,
} from "./savings.js";

export const UNATTACHED_DISKS = "azure-waste-unattached-disks";
export const OLD_SNAPSHOTS = "azure-waste-old-snapshots";
export const UNASSOCIATED_IPS = "azure-waste-unassociated-public-ips";
export const STOPPED_VMS = "azure-waste-stopped-not-deallocated-vms";
export const EMPTY_PLANS = "azure-waste-empty-app-service-plans";
export const IDLE_LOAD_BALANCERS = "azure-waste-idle-load-balancers";
export const IDLE_NAT_GATEWAYS = "azure-waste-idle-nat-gateways";
export const PROD_VM_BACKUP = "azure-resilience-prod-vms-outside-backup";
export const PROD_SQL_BACKUP = "azure-resilience-prod-sql-outside-backup";
export const DB_ZONE_OR_GEO = "azure-resilience-db-zone-or-geo";
export const RETIRING_SKUS = "azure-lifecycle-retiring-skus";
export const EXPIRING_APP_CERTS = "azure-lifecycle-expiring-app-service-certs";
export const EXPIRING_GATEWAY_CERTS = "azure-lifecycle-expiring-gateway-certs";

const MARKER_CLOSER = "Set the production tag or name pattern in Settings";

const METRICS_CLOSER = "Monitoring Reader and a metric series over a longer window";

function trafficMetrics(fields: ResourceFacts["fields"] | undefined): {
  metricWindow: string;
  byteCount: number;
} | null {
  const metricWindow = fields?.metricWindow;
  const byteCount = fields?.byteCount;
  if (typeof metricWindow !== "string" || metricWindow.length === 0 || typeof byteCount !== "number") {
    return null;
  }
  return { metricWindow, byteCount };
}

export class UnregisteredCheckError extends Error {
  constructor(checkId: string) {
    super(`unregistered check '${checkId}' cannot run`);
    this.name = "UnregisteredCheckError";
  }
}

export function acceptFinding(finding: Finding): Finding {
  assertValid(validateFinding(finding));
  return finding;
}

function subscriptionOf(resourceUri: string): string {
  return resourceUri.split("/")[2] ?? "";
}

export function scopeKey(resourceUri: string, cloud: Inventory["cloud"]): string {
  return cloud === "gcp" ? projectOf(resourceUri) : subscriptionOf(resourceUri);
}

export function checkUnattachedDisks(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  const disks = inventory.resources.filter(
    (resource) => resource.resourceType === "Microsoft.Compute/disks",
  );
  return disks.map((disk) => {
    const row = byUri.get(disk.resourceUri);
    const subscriptionOrProject = subscriptionOf(disk.resourceUri);
    const scope = {
      id: `${subscriptionOrProject}:${UNATTACHED_DISKS}`,
      cloud: "azure" as const,
      subscriptionOrProject,
    };
    const diskState = row?.fields.diskState;
    const sizeGb = row?.fields.sizeGb;
    if (typeof diskState !== "string") {
      return acceptFinding({
        checkId: UNATTACHED_DISKS,
        result: "undetermined",
        closer: "A disk read that includes diskState and managedBy",
        evidence: {
          fields: {
            diskId: disk.displayName,
            diskState: null,
            skuName: null,
            sizeGb: typeof sizeGb === "number" ? sizeGb : null,
            location: disk.region,
          },
        },
        scope,
      });
    }
    if (diskState === "Unattached") {
      if (typeof sizeGb !== "number" || sizeGb <= 0) {
        return acceptFinding({
          checkId: UNATTACHED_DISKS,
          result: "undetermined",
          closer: "A retail or agreement price row for the SKU in that region",
          evidence: {
            fields: {
              diskId: typeof row?.fields.diskId === "string" ? row.fields.diskId : disk.displayName,
              diskState,
              skuName: null,
              sizeGb: null,
              location: disk.region,
            },
          },
          scope,
        });
      }
      const savings = diskMonthlySavings(sizeGb);
      return acceptFinding({
        checkId: UNATTACHED_DISKS,
        result: "fail",
        evidence: {
          fields: {
            diskId: typeof row?.fields.diskId === "string" ? row.fields.diskId : disk.displayName,
            diskState,
            skuName: typeof row?.fields.skuName === "string" ? row.fields.skuName : null,
            sizeGb,
            location: disk.region,
            savingsBasis: savings.basis,
          },
        },
        scope,
        savings: { min: savings.min, max: savings.max, currency: savings.currency },
      });
    }
    return acceptFinding({
      checkId: UNATTACHED_DISKS,
      result: "pass",
      evidence: {
        fields: {
          diskId: typeof row?.fields.diskId === "string" ? row.fields.diskId : disk.displayName,
          diskState,
          skuName: null,
          sizeGb: typeof sizeGb === "number" ? sizeGb : null,
          location: disk.region,
        },
      },
      scope,
    });
  });
}

export function checkOldSnapshots(
  inventory: Inventory,
  facts: ResourceFacts[],
  settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  const threshold = settings.snapshotRetentionDays;
  return inventory.resources
    .filter((resource) => resource.resourceType === "Microsoft.Compute/snapshots")
    .map((snapshot) => {
      const row = byUri.get(snapshot.resourceUri);
      const subscriptionOrProject = subscriptionOf(snapshot.resourceUri);
      const scope = {
        id: `${subscriptionOrProject}:${OLD_SNAPSHOTS}`,
        cloud: "azure" as const,
        subscriptionOrProject,
      };
      if (!(threshold > 0)) {
        return acceptFinding({
          checkId: OLD_SNAPSHOTS,
          result: "undetermined",
          closer: "Set snapshot retention days in Settings",
          evidence: { fields: { snapshotId: snapshot.displayName, retentionDays: null } },
          scope,
        });
      }
      const ageDays = row?.fields.ageDays;
      if (typeof ageDays !== "number") {
        return acceptFinding({
          checkId: OLD_SNAPSHOTS,
          result: "undetermined",
          closer: "A snapshot read that includes timeCreated",
          evidence: {
            fields: {
              snapshotId: typeof row?.fields.snapshotId === "string" ? row.fields.snapshotId : snapshot.displayName,
              ageDays: null,
              retentionDays: threshold,
            },
          },
          scope,
        });
      }
      if (ageDays > threshold) {
        const savings = snapshotMonthlySavings();
        return acceptFinding({
          checkId: OLD_SNAPSHOTS,
          result: "fail",
          evidence: {
            fields: {
              snapshotId: typeof row?.fields.snapshotId === "string" ? row.fields.snapshotId : snapshot.displayName,
              ageDays,
              retentionDays: threshold,
              savingsBasis: savings.basis,
            },
          },
          scope,
          savings: { min: savings.min, max: savings.max, currency: savings.currency },
        });
      }
      return acceptFinding({
        checkId: OLD_SNAPSHOTS,
        result: "pass",
        evidence: {
          fields: {
            snapshotId: typeof row?.fields.snapshotId === "string" ? row.fields.snapshotId : snapshot.displayName,
            ageDays,
            retentionDays: threshold,
          },
        },
        scope,
      });
    });
}

export function checkUnassociatedIps(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  return inventory.resources
    .filter((resource) => resource.resourceType === "Microsoft.Network/publicIPAddresses")
    .map((ip) => {
      const row = byUri.get(ip.resourceUri);
      const subscriptionOrProject = subscriptionOf(ip.resourceUri);
      const scope = {
        id: `${subscriptionOrProject}:${UNASSOCIATED_IPS}`,
        cloud: "azure" as const,
        subscriptionOrProject,
      };
      if (!row || !Object.prototype.hasOwnProperty.call(row.fields, "associatedTo")) {
        return acceptFinding({
          checkId: UNASSOCIATED_IPS,
          result: "undetermined",
          closer: "A public IP read that includes ipConfiguration / natGateway / associated resource",
          evidence: {
            fields: {
              publicIpId: ip.displayName,
              associatedTo: null,
            },
          },
          scope,
        });
      }
      const associatedTo = row.fields.associatedTo;
      if (associatedTo == null || associatedTo === "") {
        const savings = publicIpMonthlySavings();
        return acceptFinding({
          checkId: UNASSOCIATED_IPS,
          result: "fail",
          evidence: {
            fields: {
              publicIpId: typeof row.fields.publicIpId === "string" ? row.fields.publicIpId : ip.displayName,
              associatedTo: null,
              savingsBasis: savings.basis,
            },
          },
          scope,
          savings: { min: savings.min, max: savings.max, currency: savings.currency },
        });
      }
      return acceptFinding({
        checkId: UNASSOCIATED_IPS,
        result: "pass",
        evidence: {
          fields: {
            publicIpId: typeof row.fields.publicIpId === "string" ? row.fields.publicIpId : ip.displayName,
            associatedTo,
          },
        },
        scope,
      });
    });
}

export function checkStoppedVms(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  return inventory.resources
    .filter((resource) => resource.resourceType === "Microsoft.Compute/virtualMachines")
    .map((vm) => {
      const row = byUri.get(vm.resourceUri);
      const subscriptionOrProject = subscriptionOf(vm.resourceUri);
      const scope = {
        id: `${subscriptionOrProject}:${STOPPED_VMS}`,
        cloud: "azure" as const,
        subscriptionOrProject,
      };
      const powerState = row?.fields.powerState;
      if (typeof powerState !== "string") {
        return acceptFinding({
          checkId: STOPPED_VMS,
          result: "undetermined",
          closer: "A VM instance-view read that includes powerState",
          evidence: {
            fields: {
              vmId: vm.displayName,
              powerState: null,
              vmSize: null,
              location: vm.region,
            },
          },
          scope,
        });
      }
      if (powerState === "stopped") {
        const savings = stoppedVmMonthlySavings();
        return acceptFinding({
          checkId: STOPPED_VMS,
          result: "fail",
          evidence: {
            fields: {
              vmId: typeof row?.fields.vmId === "string" ? row.fields.vmId : vm.displayName,
              powerState,
              vmSize: typeof row?.fields.vmSize === "string" ? row.fields.vmSize : null,
              location: vm.region,
              savingsBasis: savings.basis,
            },
          },
          scope,
          savings: { min: savings.min, max: savings.max, currency: savings.currency },
        });
      }
      return acceptFinding({
        checkId: STOPPED_VMS,
        result: "pass",
        evidence: {
          fields: {
            vmId: typeof row?.fields.vmId === "string" ? row.fields.vmId : vm.displayName,
            powerState,
            vmSize: typeof row?.fields.vmSize === "string" ? row.fields.vmSize : null,
            location: vm.region,
          },
        },
        scope,
      });
    });
}

export function checkEmptyPlans(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  return inventory.resources
    .filter((resource) => resource.resourceType === "Microsoft.Web/serverfarms")
    .map((plan) => {
      const row = byUri.get(plan.resourceUri);
      const subscriptionOrProject = subscriptionOf(plan.resourceUri);
      const scope = {
        id: `${subscriptionOrProject}:${EMPTY_PLANS}`,
        cloud: "azure" as const,
        subscriptionOrProject,
      };
      const numberOfSites = row?.fields.numberOfSites;
      const planId = typeof row?.fields.planId === "string" ? row.fields.planId : plan.displayName;
      const skuName = typeof row?.fields.skuName === "string" ? row.fields.skuName : null;
      const kind = typeof row?.fields.kind === "string" ? row.fields.kind : null;
      if (typeof numberOfSites !== "number") {
        return acceptFinding({
          checkId: EMPTY_PLANS,
          result: "undetermined",
          closer: "A plan read that includes numberOfSites, or a complete sites list",
          evidence: { fields: { planId, skuName, numberOfSites: null, kind } },
          scope,
        });
      }
      if (numberOfSites === 0) {
        const savings = emptyPlanMonthlySavings();
        return acceptFinding({
          checkId: EMPTY_PLANS,
          result: "fail",
          evidence: {
            fields: {
              planId,
              skuName,
              numberOfSites,
              kind,
              savingsBasis: savings.basis,
            },
          },
          scope,
          savings: { min: savings.min, max: savings.max, currency: savings.currency },
        });
      }
      return acceptFinding({
        checkId: EMPTY_PLANS,
        result: "pass",
        evidence: { fields: { planId, skuName, numberOfSites, kind } },
        scope,
      });
    });
}

export function checkIdleLoadBalancers(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  return inventory.resources
    .filter((resource) => resource.resourceType === "Microsoft.Network/loadBalancers")
    .map((lb) => {
      const row = byUri.get(lb.resourceUri);
      const subscriptionOrProject = subscriptionOf(lb.resourceUri);
      const scope = {
        id: `${subscriptionOrProject}:${IDLE_LOAD_BALANCERS}`,
        cloud: "azure" as const,
        subscriptionOrProject,
      };
      const loadBalancerId =
        typeof row?.fields.loadBalancerId === "string" ? row.fields.loadBalancerId : lb.displayName;
      const skuName = typeof row?.fields.skuName === "string" ? row.fields.skuName : null;
      const backendAddressCount = row?.fields.backendAddressCount;
      if (typeof backendAddressCount !== "number") {
        return acceptFinding({
          checkId: IDLE_LOAD_BALANCERS,
          result: "undetermined",
          closer: "A load balancer read that includes backend address pools",
          evidence: {
            fields: { loadBalancerId, skuName, backendAddressCount: null, metricWindow: null },
          },
          scope,
        });
      }
      const metrics = trafficMetrics(row?.fields);
      if (!metrics) {
        return acceptFinding({
          checkId: IDLE_LOAD_BALANCERS,
          result: "undetermined",
          closer: METRICS_CLOSER,
          evidence: {
            fields: { loadBalancerId, skuName, backendAddressCount, metricWindow: null },
          },
          scope,
        });
      }
      if (backendAddressCount === 0 || metrics.byteCount === 0) {
        const savings = idleLbMonthlySavings();
        return acceptFinding({
          checkId: IDLE_LOAD_BALANCERS,
          result: "fail",
          evidence: {
            fields: {
              loadBalancerId,
              skuName,
              backendAddressCount,
              metricWindow: metrics.metricWindow,
              savingsBasis: savings.basis,
            },
          },
          scope,
          savings: { min: savings.min, max: savings.max, currency: savings.currency },
        });
      }
      return acceptFinding({
        checkId: IDLE_LOAD_BALANCERS,
        result: "pass",
        evidence: {
          fields: {
            loadBalancerId,
            skuName,
            backendAddressCount,
            metricWindow: metrics.metricWindow,
          },
        },
        scope,
      });
    });
}

export function checkIdleNatGateways(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  return inventory.resources
    .filter((resource) => resource.resourceType === "Microsoft.Network/natGateways")
    .map((nat) => {
      const row = byUri.get(nat.resourceUri);
      const subscriptionOrProject = subscriptionOf(nat.resourceUri);
      const scope = {
        id: `${subscriptionOrProject}:${IDLE_NAT_GATEWAYS}`,
        cloud: "azure" as const,
        subscriptionOrProject,
      };
      const natGatewayId =
        typeof row?.fields.natGatewayId === "string" ? row.fields.natGatewayId : nat.displayName;
      const skuName = typeof row?.fields.skuName === "string" ? row.fields.skuName : null;
      const attachedSubnetCount = row?.fields.attachedSubnetCount;
      if (typeof attachedSubnetCount !== "number") {
        return acceptFinding({
          checkId: IDLE_NAT_GATEWAYS,
          result: "undetermined",
          closer: "A NAT gateway read that includes subnets",
          evidence: {
            fields: { natGatewayId, attachedSubnetCount: null, skuName, metricWindow: null },
          },
          scope,
        });
      }
      const metrics = trafficMetrics(row?.fields);
      if (!metrics) {
        return acceptFinding({
          checkId: IDLE_NAT_GATEWAYS,
          result: "undetermined",
          closer: METRICS_CLOSER,
          evidence: {
            fields: { natGatewayId, attachedSubnetCount, skuName, metricWindow: null },
          },
          scope,
        });
      }
      if (attachedSubnetCount === 0 || metrics.byteCount === 0) {
        const savings = idleNatMonthlySavings();
        return acceptFinding({
          checkId: IDLE_NAT_GATEWAYS,
          result: "fail",
          evidence: {
            fields: {
              natGatewayId,
              attachedSubnetCount,
              skuName,
              metricWindow: metrics.metricWindow,
              savingsBasis: savings.basis,
            },
          },
          scope,
          savings: { min: savings.min, max: savings.max, currency: savings.currency },
        });
      }
      return acceptFinding({
        checkId: IDLE_NAT_GATEWAYS,
        result: "pass",
        evidence: {
          fields: {
            natGatewayId,
            attachedSubnetCount,
            skuName,
            metricWindow: metrics.metricWindow,
          },
        },
        scope,
      });
    });
}

function configuredMarker(settings: OrgSettings): string | null {
  if (settings.productionTagKey.length === 0 || settings.productionTagValue.length === 0) {
    return null;
  }
  return `${settings.productionTagKey}=${settings.productionTagValue}`;
}

function checkProductionBackup(
  inventory: Inventory,
  facts: ResourceFacts[],
  settings: OrgSettings,
  spec: {
    checkId: string;
    resourceType: string;
    idField: "vmId" | "sqlResourceId";
    roleCloser: string;
  },
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  const resources = inventory.resources.filter((resource) => resource.resourceType === spec.resourceType);
  const marker = configuredMarker(settings);
  if (!marker) {
    return resources.map((resource) => {
      const row = byUri.get(resource.resourceUri);
      const subscriptionOrProject = subscriptionOf(resource.resourceUri);
      const rawId = row?.fields[spec.idField];
      const id = typeof rawId === "string" ? rawId : resource.displayName;
      return acceptFinding({
        checkId: spec.checkId,
        result: "undetermined",
        closer: MARKER_CLOSER,
        evidence: {
          fields: { [spec.idField]: id, productionMarker: null, vaultId: null, protected: null },
        },
        scope: {
          id: `${subscriptionOrProject}:${spec.checkId}`,
          cloud: "azure",
          subscriptionOrProject,
        },
      });
    });
  }
  const production = resources.filter(
    (resource) => resource.tags[settings.productionTagKey] === settings.productionTagValue,
  );
  const productionCount = production.length;
  const unprotectedCount = production.filter(
    (resource) => byUri.get(resource.resourceUri)?.fields.protected === false,
  ).length;
  return production.map((resource) => {
    const row = byUri.get(resource.resourceUri);
    const subscriptionOrProject = subscriptionOf(resource.resourceUri);
    const scope = {
      id: `${subscriptionOrProject}:${spec.checkId}`,
      cloud: "azure" as const,
      subscriptionOrProject,
    };
    const rawId = row?.fields[spec.idField];
    const id = typeof rawId === "string" ? rawId : resource.displayName;
    const vaultId = typeof row?.fields.vaultId === "string" ? row.fields.vaultId : null;
    if (typeof row?.fields.protected !== "boolean") {
      return acceptFinding({
        checkId: spec.checkId,
        result: "undetermined",
        closer: spec.roleCloser,
        evidence: {
          fields: { [spec.idField]: id, productionMarker: marker, vaultId, protected: null },
        },
        scope,
      });
    }
    if (row.fields.protected === false) {
      return acceptFinding({
        checkId: spec.checkId,
        result: "fail",
        evidence: {
          fields: {
            [spec.idField]: id,
            productionMarker: marker,
            vaultId,
            protected: false,
            unprotectedCount,
            productionCount,
          },
        },
        scope,
      });
    }
    return acceptFinding({
      checkId: spec.checkId,
      result: "pass",
      evidence: {
        fields: {
          [spec.idField]: id,
          productionMarker: marker,
          vaultId,
          protected: true,
          productionCount,
        },
      },
      scope,
    });
  });
}

export function checkProdVmBackup(
  inventory: Inventory,
  facts: ResourceFacts[],
  settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  return checkProductionBackup(inventory, facts, settings, {
    checkId: PROD_VM_BACKUP,
    resourceType: "Microsoft.Compute/virtualMachines",
    idField: "vmId",
    roleCloser: "Backup Reader on the vaults in scope",
  });
}

export function checkProdSqlBackup(
  inventory: Inventory,
  facts: ResourceFacts[],
  settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  return checkProductionBackup(inventory, facts, settings, {
    checkId: PROD_SQL_BACKUP,
    resourceType: "Microsoft.Sql/servers/databases",
    idField: "sqlResourceId",
    roleCloser: "Backup Reader on the relevant vaults and a list of SQL backup items",
  });
}

export function checkDbZoneOrGeo(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  return inventory.resources
    .filter((resource) => resource.resourceType === "Microsoft.Sql/servers/databases")
    .map((database) => {
      const row = byUri.get(database.resourceUri);
      const subscriptionOrProject = subscriptionOf(database.resourceUri);
      const scope = {
        id: `${subscriptionOrProject}:${DB_ZONE_OR_GEO}`,
        cloud: "azure" as const,
        subscriptionOrProject,
      };
      const databaseId =
        typeof row?.fields.databaseId === "string" ? row.fields.databaseId : database.displayName;
      const engine = typeof row?.fields.engine === "string" ? row.fields.engine : null;
      const zoneRedundant = row?.fields.zoneRedundant;
      const backupRedundancy = row?.fields.backupRedundancy;
      if (typeof zoneRedundant !== "boolean" || typeof backupRedundancy !== "string") {
        return acceptFinding({
          checkId: DB_ZONE_OR_GEO,
          result: "undetermined",
          closer: "A database read that includes those properties for that engine",
          evidence: {
            fields: {
              databaseId,
              engine,
              zoneRedundant: typeof zoneRedundant === "boolean" ? zoneRedundant : null,
              backupRedundancy: typeof backupRedundancy === "string" ? backupRedundancy : null,
            },
          },
          scope,
        });
      }
      const missing = [
        zoneRedundant === true ? null : "zone redundancy",
        /geo/i.test(backupRedundancy) ? null : "geo-backup",
      ].filter((item): item is string => item !== null);
      if (missing.length > 0) {
        return acceptFinding({
          checkId: DB_ZONE_OR_GEO,
          result: "fail",
          evidence: {
            fields: {
              databaseId,
              engine,
              zoneRedundant,
              backupRedundancy,
              missingSetting: missing.join(" and "),
            },
          },
          scope,
        });
      }
      return acceptFinding({
        checkId: DB_ZONE_OR_GEO,
        result: "pass",
        evidence: { fields: { databaseId, engine, zoneRedundant, backupRedundancy } },
        scope,
      });
    });
}

export function checkRetiringSkus(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const catalogue = loadRetiringSkus();
  const bySku = new Map(catalogue.entries.map((entry) => [entry.skuName, entry]));
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  return inventory.resources.flatMap((resource) => {
    const row = byUri.get(resource.resourceUri);
    const skuName =
      typeof row?.fields.skuName === "string"
        ? row.fields.skuName
        : typeof row?.fields.vmSize === "string"
          ? row.fields.vmSize
          : null;
    if (skuName == null) {
      return [];
    }
    const subscriptionOrProject = subscriptionOf(resource.resourceUri);
    const scope = {
      id: `${subscriptionOrProject}:${RETIRING_SKUS}`,
      cloud: "azure" as const,
      subscriptionOrProject,
    };
    const resourceId = resource.resourceUri.split("/").pop() ?? resource.displayName;
    const listed = bySku.get(skuName);
    if (listed) {
      return [
        acceptFinding({
          checkId: RETIRING_SKUS,
          result: "fail",
          evidence: {
            fields: {
              resourceId,
              skuName,
              retirementDate: listed.retirementDate,
              announcementId: listed.announcementId,
              source: listed.source,
            },
          },
          scope,
        }),
      ];
    }
    return [
      acceptFinding({
        checkId: RETIRING_SKUS,
        result: "pass",
        evidence: {
          fields: {
            resourceId,
            skuName,
            catalogueVersion: catalogue.version,
            cataloguePublishedAt: catalogue.publishedAt,
            source: catalogue.source,
          },
        },
        scope,
      }),
    ];
  });
}

function checkExpiringCerts(
  inventory: Inventory,
  facts: ResourceFacts[],
  settings: OrgSettings,
  spec: {
    checkId: string;
    resourceType: string;
    idField: "certificateId" | "gatewayId";
    nameField: "hostName" | "certificateName";
  },
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  const threshold = settings.certExpiryFlagDays;
  return inventory.resources
    .filter((resource) => resource.resourceType === spec.resourceType)
    .map((resource) => {
      const row = byUri.get(resource.resourceUri);
      const subscriptionOrProject = subscriptionOf(resource.resourceUri);
      const scope = {
        id: `${subscriptionOrProject}:${spec.checkId}`,
        cloud: "azure" as const,
        subscriptionOrProject,
      };
      const rawId = row?.fields[spec.idField];
      const id = typeof rawId === "string" ? rawId : resource.displayName;
      const rawName = row?.fields[spec.nameField];
      const name = typeof rawName === "string" ? rawName : null;
      const expirationDate =
        typeof row?.fields.expirationDate === "string" ? row.fields.expirationDate : null;
      if (!(threshold > 0)) {
        return acceptFinding({
          checkId: spec.checkId,
          result: "undetermined",
          closer: "Set certificate expiry warning days in Settings",
          evidence: {
            fields: { [spec.idField]: id, [spec.nameField]: name, expirationDate, daysRemaining: null },
          },
          scope,
        });
      }
      const daysRemaining = row?.fields.daysRemaining;
      if (typeof daysRemaining !== "number") {
        return acceptFinding({
          checkId: spec.checkId,
          result: "undetermined",
          closer: "A certificate read that includes expirationDate",
          evidence: {
            fields: { [spec.idField]: id, [spec.nameField]: name, expirationDate, daysRemaining: null },
          },
          scope,
        });
      }
      if (daysRemaining <= threshold) {
        return acceptFinding({
          checkId: spec.checkId,
          result: "fail",
          evidence: {
            fields: {
              [spec.idField]: id,
              [spec.nameField]: name,
              expirationDate,
              daysRemaining,
            },
          },
          scope,
        });
      }
      return acceptFinding({
        checkId: spec.checkId,
        result: "pass",
        evidence: {
          fields: { [spec.idField]: id, [spec.nameField]: name, expirationDate, daysRemaining },
        },
        scope,
      });
    });
}

export function checkExpiringAppCerts(
  inventory: Inventory,
  facts: ResourceFacts[],
  settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  return checkExpiringCerts(inventory, facts, settings, {
    checkId: EXPIRING_APP_CERTS,
    resourceType: "Microsoft.Web/certificates",
    idField: "certificateId",
    nameField: "hostName",
  });
}

export function checkExpiringGatewayCerts(
  inventory: Inventory,
  facts: ResourceFacts[],
  settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  return checkExpiringCerts(inventory, facts, settings, {
    checkId: EXPIRING_GATEWAY_CERTS,
    resourceType: "Microsoft.Network/applicationGateways",
    idField: "gatewayId",
    nameField: "certificateName",
  });
}

type CheckFn = (inventory: Inventory, facts: ResourceFacts[], settings: OrgSettings) => Finding[];

export const CHECK_REGISTRY: Record<string, CheckFn> = {
  [UNATTACHED_DISKS]: checkUnattachedDisks,
  [OLD_SNAPSHOTS]: checkOldSnapshots,
  [UNASSOCIATED_IPS]: checkUnassociatedIps,
  [STOPPED_VMS]: checkStoppedVms,
  [EMPTY_PLANS]: checkEmptyPlans,
  [IDLE_LOAD_BALANCERS]: checkIdleLoadBalancers,
  [IDLE_NAT_GATEWAYS]: checkIdleNatGateways,
  [PROD_VM_BACKUP]: checkProdVmBackup,
  [PROD_SQL_BACKUP]: checkProdSqlBackup,
  [DB_ZONE_OR_GEO]: checkDbZoneOrGeo,
  [RETIRING_SKUS]: checkRetiringSkus,
  [EXPIRING_APP_CERTS]: checkExpiringAppCerts,
  [EXPIRING_GATEWAY_CERTS]: checkExpiringGatewayCerts,
  [GCP_UNATTACHED_DISKS]: checkGcpUnattachedDisks,
  [GCP_UNUSED_IPS]: checkGcpUnusedIps,
  [GCP_OLD_SNAPSHOTS_AND_IMAGES]: checkGcpOldSnapshotsAndImages,
};

export function registeredCheckIds(cloud: Inventory["cloud"]): string[] {
  const prefix = cloud === "gcp" ? "gcp-" : "azure-";
  return Object.keys(CHECK_REGISTRY).filter((id) => id.startsWith(prefix));
}

export function runChecks(input: {
  inventory: Inventory;
  facts: ResourceFacts[];
  checkIds: string[];
  unreadSubscriptions?: string[];
  settings?: OrgSettings;
}): { findings: Finding[]; coverage: CoverageEntry[] } {
  const findings: Finding[] = [];
  const coverage: CoverageEntry[] = [];
  const subscriptions = [
    ...new Set(
      input.inventory.resources.map((resource) => scopeKey(resource.resourceUri, input.inventory.cloud)),
    ),
  ].filter(Boolean);

  for (const checkId of input.checkIds) {
    const impl = CHECK_REGISTRY[checkId];
    if (!impl) {
      throw new UnregisteredCheckError(checkId);
    }
    findings.push(
      ...impl(input.inventory, input.facts, input.settings ?? DEFAULT_SETTINGS).map(acceptFinding),
    );
    for (const subscriptionOrProject of subscriptions) {
      coverage.push(
        recordCoverageScope({
          subscriptionOrProject,
          checkId,
          state: "assessed",
        }),
      );
    }
    for (const unread of input.unreadSubscriptions ?? []) {
      coverage.push(
        recordCoverageScope({
          subscriptionOrProject: unread,
          checkId,
          state: "unassessed",
          causeId: "failed_call",
        }),
      );
    }
  }
  return { findings, coverage };
}
