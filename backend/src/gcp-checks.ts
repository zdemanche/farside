import { assertValid, validateFinding, type Finding, type Inventory } from "@farside/scan-contracts";
import type { ResourceFacts } from "./facts.js";
import { projectOf } from "./gcp-inventory.js";
import { gcpDiskMonthlySavings, gcpIpMonthlySavings, gcpSnapshotImageMonthlySavings } from "./savings.js";
import type { OrgSettings } from "./settings.js";
import { DEFAULT_SETTINGS } from "./settings.js";

export const GCP_UNATTACHED_DISKS = "gcp-waste-unattached-disks";
export const GCP_UNUSED_IPS = "gcp-waste-unused-external-ips";
export const GCP_OLD_SNAPSHOTS_AND_IMAGES = "gcp-waste-old-snapshots-and-images";

const DISK_TYPE = "compute.googleapis.com/Disk";
const ADDRESS_TYPE = "compute.googleapis.com/Address";
const SNAPSHOT_TYPE = "compute.googleapis.com/Snapshot";
const IMAGE_TYPE = "compute.googleapis.com/Image";

function acceptFinding(finding: Finding): Finding {
  assertValid(validateFinding(finding));
  return finding;
}

function gcpScope(resourceUri: string, checkId: string) {
  const subscriptionOrProject = projectOf(resourceUri);
  return {
    id: `${subscriptionOrProject}:${checkId}`,
    cloud: "gcp" as const,
    subscriptionOrProject,
  };
}

function fieldString(fields: ResourceFacts["fields"] | undefined, key: string, fallback: string): string {
  const value = fields?.[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function checkGcpUnattachedDisks(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  return inventory.resources
    .filter((resource) => resource.resourceType === DISK_TYPE)
    .map((disk) => {
      const row = byUri.get(disk.resourceUri);
      const scope = gcpScope(disk.resourceUri, GCP_UNATTACHED_DISKS);
      const usersCount = row?.fields.usersCount;
      const sizeGb = row?.fields.sizeGb;
      const diskId = fieldString(row?.fields, "diskId", disk.displayName);
      const zone = fieldString(row?.fields, "location", disk.region);
      if (typeof usersCount !== "number") {
        return acceptFinding({
          checkId: GCP_UNATTACHED_DISKS,
          result: "undetermined",
          closer: "A disk read that includes the users list",
          evidence: {
            fields: {
              diskId,
              usersCount: null,
              sizeGb: typeof sizeGb === "number" ? sizeGb : null,
              zone,
            },
          },
          scope,
        });
      }
      if (usersCount === 0) {
        if (typeof sizeGb !== "number" || sizeGb <= 0) {
          return acceptFinding({
            checkId: GCP_UNATTACHED_DISKS,
            result: "undetermined",
            closer: "A disk read that includes sizeGb",
            evidence: { fields: { diskId, usersCount, sizeGb: null, zone } },
            scope,
          });
        }
        const savings = gcpDiskMonthlySavings(sizeGb);
        return acceptFinding({
          checkId: GCP_UNATTACHED_DISKS,
          result: "fail",
          evidence: {
            fields: { diskId, usersCount, sizeGb, zone, savingsBasis: savings.basis },
          },
          scope,
          savings: { min: savings.min, max: savings.max, currency: savings.currency },
        });
      }
      return acceptFinding({
        checkId: GCP_UNATTACHED_DISKS,
        result: "pass",
        evidence: {
          fields: {
            diskId,
            usersCount,
            sizeGb: typeof sizeGb === "number" ? sizeGb : null,
            zone,
          },
        },
        scope,
      });
    });
}

export function checkGcpUnusedIps(
  inventory: Inventory,
  facts: ResourceFacts[],
  _settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  return inventory.resources
    .filter((resource) => resource.resourceType === ADDRESS_TYPE)
    .map((address) => {
      const row = byUri.get(address.resourceUri);
      const scope = gcpScope(address.resourceUri, GCP_UNUSED_IPS);
      const status = row?.fields.status;
      const usersCount = row?.fields.usersCount;
      const addressId = fieldString(row?.fields, "addressId", address.displayName);
      const ip = fieldString(row?.fields, "address", address.displayName);
      const region = fieldString(row?.fields, "location", address.region);
      if (typeof status !== "string" || typeof usersCount !== "number") {
        return acceptFinding({
          checkId: GCP_UNUSED_IPS,
          result: "undetermined",
          closer: "An address read that includes status and users",
          evidence: {
            fields: {
              addressId,
              address: ip,
              status: typeof status === "string" ? status : null,
              usersCount: typeof usersCount === "number" ? usersCount : null,
              region,
            },
          },
          scope,
        });
      }
      if (status === "RESERVED" && usersCount === 0) {
        const savings = gcpIpMonthlySavings();
        return acceptFinding({
          checkId: GCP_UNUSED_IPS,
          result: "fail",
          evidence: {
            fields: {
              addressId,
              address: ip,
              status,
              usersCount,
              region,
              savingsBasis: savings.basis,
            },
          },
          scope,
          savings: { min: savings.min, max: savings.max, currency: savings.currency },
        });
      }
      return acceptFinding({
        checkId: GCP_UNUSED_IPS,
        result: "pass",
        evidence: {
          fields: { addressId, address: ip, status, usersCount, region },
        },
        scope,
      });
    });
}

export function checkGcpOldSnapshotsAndImages(
  inventory: Inventory,
  facts: ResourceFacts[],
  settings: OrgSettings = DEFAULT_SETTINGS,
): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  const threshold = settings.snapshotRetentionDays;
  return inventory.resources
    .filter((resource) => resource.resourceType === SNAPSHOT_TYPE || resource.resourceType === IMAGE_TYPE)
    .map((item) => {
      const row = byUri.get(item.resourceUri);
      const scope = gcpScope(item.resourceUri, GCP_OLD_SNAPSHOTS_AND_IMAGES);
      const snapshotOrImageId = fieldString(row?.fields, "snapshotOrImageId", item.displayName);
      const creationTimestamp =
        typeof row?.fields.creationTimestamp === "string" ? row.fields.creationTimestamp : null;
      if (!(threshold > 0)) {
        return acceptFinding({
          checkId: GCP_OLD_SNAPSHOTS_AND_IMAGES,
          result: "undetermined",
          closer: "Set snapshot retention days in Settings",
          evidence: {
            fields: { snapshotOrImageId, creationTimestamp, ageDays: null, retentionDays: null },
          },
          scope,
        });
      }
      const ageDays = row?.fields.ageDays;
      if (typeof ageDays !== "number") {
        return acceptFinding({
          checkId: GCP_OLD_SNAPSHOTS_AND_IMAGES,
          result: "undetermined",
          closer: "A snapshot or image read that includes creationTimestamp",
          evidence: {
            fields: { snapshotOrImageId, creationTimestamp, ageDays: null, retentionDays: threshold },
          },
          scope,
        });
      }
      if (ageDays > threshold) {
        const sizeGb = row?.fields.sizeGb;
        if (typeof sizeGb !== "number" || sizeGb <= 0) {
          return acceptFinding({
            checkId: GCP_OLD_SNAPSHOTS_AND_IMAGES,
            result: "undetermined",
            closer: "A snapshot or image read that includes sizeGb",
            evidence: {
              fields: { snapshotOrImageId, creationTimestamp, ageDays, retentionDays: threshold },
            },
            scope,
          });
        }
        const savings = gcpSnapshotImageMonthlySavings(sizeGb);
        return acceptFinding({
          checkId: GCP_OLD_SNAPSHOTS_AND_IMAGES,
          result: "fail",
          evidence: {
            fields: {
              snapshotOrImageId,
              creationTimestamp,
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
        checkId: GCP_OLD_SNAPSHOTS_AND_IMAGES,
        result: "pass",
        evidence: {
          fields: { snapshotOrImageId, creationTimestamp, ageDays, retentionDays: threshold },
        },
        scope,
      });
    });
}
