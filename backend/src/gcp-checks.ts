import { defineGcpCheck, fail, nonEmptyStr, num, pass, str, undetermined } from "./checks/define.js";
import { gcpDiskMonthlySavings, gcpIpMonthlySavings, gcpSnapshotImageMonthlySavings } from "./savings.js";

export const GCP_UNATTACHED_DISKS = "gcp-waste-unattached-disks";
export const GCP_UNUSED_IPS = "gcp-waste-unused-external-ips";
export const GCP_OLD_SNAPSHOTS_AND_IMAGES = "gcp-waste-old-snapshots-and-images";

export const checkGcpUnattachedDisks = defineGcpCheck({
  checkId: GCP_UNATTACHED_DISKS,
  resourceType: "compute.googleapis.com/Disk",
  readFacts: (disk, fields) => ({
    usersCount: num(fields, "usersCount"),
    sizeGb: num(fields, "sizeGb"),
    diskId: nonEmptyStr(fields, "diskId") ?? disk.displayName,
    zone: nonEmptyStr(fields, "location") ?? disk.region,
  }),
  decide: ({ usersCount, sizeGb, diskId, zone }, { resource: disk }) => {
    const evidence = { resourceUri: disk.resourceUri, diskId, usersCount, sizeGb, zone };
    if (usersCount === null) {
      return undetermined("A disk read that includes the users list", evidence);
    }
    if (usersCount !== 0) {
      return pass(evidence);
    }
    if (sizeGb === null || sizeGb <= 0) {
      return undetermined("A disk read that includes sizeGb", { ...evidence, sizeGb: null });
    }
    return fail(evidence, gcpDiskMonthlySavings(sizeGb));
  },
});

export const checkGcpUnusedIps = defineGcpCheck({
  checkId: GCP_UNUSED_IPS,
  resourceType: "compute.googleapis.com/Address",
  readFacts: (address, fields) => ({
    status: str(fields, "status"),
    usersCount: num(fields, "usersCount"),
    addressId: nonEmptyStr(fields, "addressId") ?? address.displayName,
    ip: nonEmptyStr(fields, "address") ?? address.displayName,
    region: nonEmptyStr(fields, "location") ?? address.region,
  }),
  decide: ({ status, usersCount, addressId, ip, region }, { resource: address }) => {
    const evidence = { resourceUri: address.resourceUri, addressId, address: ip, status, usersCount, region };
    if (status === null || usersCount === null) {
      return undetermined("An address read that includes status and users", evidence);
    }
    return status === "RESERVED" && usersCount === 0 ? fail(evidence, gcpIpMonthlySavings()) : pass(evidence);
  },
});

export const checkGcpOldSnapshotsAndImages = defineGcpCheck({
  checkId: GCP_OLD_SNAPSHOTS_AND_IMAGES,
  resourceType: ["compute.googleapis.com/Snapshot", "compute.googleapis.com/Image"],
  readFacts: (item, fields, settings) => ({
    threshold: settings.snapshotRetentionDays,
    snapshotOrImageId: nonEmptyStr(fields, "snapshotOrImageId") ?? item.displayName,
    creationTimestamp: str(fields, "creationTimestamp"),
    ageDays: num(fields, "ageDays"),
    sizeGb: num(fields, "sizeGb"),
  }),
  decide: ({ threshold, snapshotOrImageId, creationTimestamp, ageDays, sizeGb }, { resource: item }) => {
    const evidence = {
      resourceUri: item.resourceUri,
      snapshotOrImageId,
      creationTimestamp,
      ageDays,
      retentionDays: threshold,
    };
    if (!(threshold > 0)) {
      return undetermined("Set snapshot retention days in Settings", {
        ...evidence,
        ageDays: null,
        retentionDays: null,
      });
    }
    if (ageDays === null) {
      return undetermined("A snapshot or image read that includes creationTimestamp", evidence);
    }
    if (ageDays <= threshold) {
      return pass(evidence);
    }
    if (sizeGb === null || sizeGb <= 0) {
      return undetermined("A snapshot or image read that includes sizeGb", evidence);
    }
    return fail(evidence, gcpSnapshotImageMonthlySavings(sizeGb));
  },
});
