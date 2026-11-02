import {
  assertValid,
  validateFinding,
  type Finding,
  type Inventory,
} from "@farside/scan-contracts";
import { AZURE_LAUNCH_CHECK_IDS, recordCoverageScope, type CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import type { OrgSettings } from "./settings.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import {
  diskMonthlySavings,
  publicIpMonthlySavings,
  snapshotMonthlySavings,
  stoppedVmMonthlySavings,
} from "./savings.js";

export const UNATTACHED_DISKS = "azure-waste-unattached-disks";
export const OLD_SNAPSHOTS = "azure-waste-old-snapshots";
export const UNASSOCIATED_IPS = "azure-waste-unassociated-public-ips";
export const STOPPED_VMS = "azure-waste-stopped-not-deallocated-vms";

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

type CheckFn = (inventory: Inventory, facts: ResourceFacts[], settings: OrgSettings) => Finding[];

export const CHECK_REGISTRY: Record<string, CheckFn> = {
  [UNATTACHED_DISKS]: checkUnattachedDisks,
  [OLD_SNAPSHOTS]: checkOldSnapshots,
  [UNASSOCIATED_IPS]: checkUnassociatedIps,
  [STOPPED_VMS]: checkStoppedVms,
};

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
    ...new Set(input.inventory.resources.map((resource) => subscriptionOf(resource.resourceUri))),
  ].filter(Boolean);

  for (const checkId of input.checkIds) {
    if (!(AZURE_LAUNCH_CHECK_IDS as readonly string[]).includes(checkId)) {
      throw new UnregisteredCheckError(checkId);
    }
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
