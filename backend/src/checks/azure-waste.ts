import {
  diskMonthlySavings,
  emptyPlanMonthlySavings,
  idleLbMonthlySavings,
  idleNatMonthlySavings,
  publicIpMonthlySavings,
  snapshotMonthlySavings,
  stoppedVmMonthlySavings,
  type NamedSavingsRange,
} from "../savings.js";
import { defineAzureCheck, fail, num, pass, str, undetermined } from "./define.js";

export const UNATTACHED_DISKS = "azure-waste-unattached-disks";
export const OLD_SNAPSHOTS = "azure-waste-old-snapshots";
export const UNASSOCIATED_IPS = "azure-waste-unassociated-public-ips";
export const STOPPED_VMS = "azure-waste-stopped-not-deallocated-vms";
export const EMPTY_PLANS = "azure-waste-empty-app-service-plans";
export const IDLE_LOAD_BALANCERS = "azure-waste-idle-load-balancers";
export const IDLE_NAT_GATEWAYS = "azure-waste-idle-nat-gateways";

const METRICS_CLOSER = "Monitoring Reader and a metric series over a longer window";

export const checkUnattachedDisks = defineAzureCheck({
  checkId: UNATTACHED_DISKS,
  resourceType: "Microsoft.Compute/disks",
  readFacts: (disk, fields) => ({
    state: str(fields, "diskState"),
    sizeGb: num(fields, "sizeGb"),
    diskId: str(fields, "diskId") ?? disk.displayName,
    skuName: str(fields, "skuName"),
  }),
  decide: ({ state, sizeGb, diskId, skuName }, { resource: disk }) => {
    const evidence = { resourceUri: disk.resourceUri, diskId, diskState: state, skuName: null, sizeGb, location: disk.region };
    if (state === null) {
      return undetermined("A disk read that includes diskState and managedBy", {
        ...evidence,
        diskId: disk.displayName,
      });
    }
    if (state !== "Unattached") {
      return pass(evidence);
    }
    if (sizeGb === null || sizeGb <= 0) {
      return undetermined("A retail or agreement price row for the SKU in that region", {
        ...evidence,
        sizeGb: null,
      });
    }
    return fail({ ...evidence, skuName }, diskMonthlySavings(sizeGb));
  },
});

export const checkOldSnapshots = defineAzureCheck({
  checkId: OLD_SNAPSHOTS,
  resourceType: "Microsoft.Compute/snapshots",
  readFacts: (snapshot, fields, settings) => ({
    threshold: settings.snapshotRetentionDays,
    ageDays: num(fields, "ageDays"),
    snapshotId: str(fields, "snapshotId") ?? snapshot.displayName,
  }),
  decide: ({ threshold, ageDays, snapshotId }, { resource: snapshot }) => {
    const uri = snapshot.resourceUri;
    if (!(threshold > 0)) {
      return undetermined("Set snapshot retention days in Settings", {
        resourceUri: uri,
        snapshotId: snapshot.displayName,
        retentionDays: null,
      });
    }
    if (ageDays === null) {
      return undetermined("A snapshot read that includes timeCreated", {
        resourceUri: uri,
        snapshotId,
        ageDays: null,
        retentionDays: threshold,
      });
    }
    const evidence = { resourceUri: uri, snapshotId, ageDays, retentionDays: threshold };
    return ageDays > threshold ? fail(evidence, snapshotMonthlySavings()) : pass(evidence);
  },
});

export const checkUnassociatedIps = defineAzureCheck({
  checkId: UNASSOCIATED_IPS,
  resourceType: "Microsoft.Network/publicIPAddresses",
  readFacts: (ip, fields) => ({
    known: fields !== undefined && Object.hasOwn(fields, "associatedTo"),
    associatedTo: fields?.associatedTo ?? null,
    publicIpId: str(fields, "publicIpId") ?? ip.displayName,
  }),
  decide: ({ known, associatedTo, publicIpId }, { resource: ip }) => {
    if (!known) {
      return undetermined("A public IP read that includes ipConfiguration / natGateway / associated resource", {
        resourceUri: ip.resourceUri,
        publicIpId: ip.displayName,
        associatedTo: null,
      });
    }
    if (associatedTo === null || associatedTo === "") {
      return fail({ resourceUri: ip.resourceUri, publicIpId, associatedTo: null }, publicIpMonthlySavings());
    }
    return pass({ resourceUri: ip.resourceUri, publicIpId, associatedTo });
  },
});

export const checkStoppedVms = defineAzureCheck({
  checkId: STOPPED_VMS,
  resourceType: "Microsoft.Compute/virtualMachines",
  readFacts: (vm, fields) => ({
    powerState: str(fields, "powerState"),
    vmId: str(fields, "vmId") ?? vm.displayName,
    vmSize: str(fields, "vmSize"),
  }),
  decide: ({ powerState, vmId, vmSize }, { resource: vm }) => {
    if (powerState === null) {
      return undetermined("A VM instance-view read that includes powerState", {
        resourceUri: vm.resourceUri,
        vmId: vm.displayName,
        powerState: null,
        vmSize: null,
        location: vm.region,
      });
    }
    const evidence = { resourceUri: vm.resourceUri, vmId, powerState, vmSize, location: vm.region };
    return powerState === "stopped" ? fail(evidence, stoppedVmMonthlySavings()) : pass(evidence);
  },
});

export const checkEmptyPlans = defineAzureCheck({
  checkId: EMPTY_PLANS,
  resourceType: "Microsoft.Web/serverfarms",
  readFacts: (plan, fields) => ({
    numberOfSites: num(fields, "numberOfSites"),
    planId: str(fields, "planId") ?? plan.displayName,
    skuName: str(fields, "skuName"),
    kind: str(fields, "kind"),
  }),
  decide: ({ numberOfSites, planId, skuName, kind }, { resource: plan }) => {
    const evidence = { resourceUri: plan.resourceUri, planId, skuName, numberOfSites, kind };
    if (numberOfSites === null) {
      return undetermined("A plan read that includes numberOfSites, or a complete sites list", evidence);
    }
    return numberOfSites === 0 ? fail(evidence, emptyPlanMonthlySavings()) : pass(evidence);
  },
});

function idleTrafficCheck(spec: {
  checkId: string;
  resourceType: string;
  idField: "loadBalancerId" | "natGatewayId";
  countField: "backendAddressCount" | "attachedSubnetCount";
  countBeforeSku?: boolean;
  countCloser: string;
  savings: () => NamedSavingsRange;
}) {
  return defineAzureCheck({
    checkId: spec.checkId,
    resourceType: spec.resourceType,
    readFacts: (resource, fields) => ({
      id: str(fields, spec.idField) ?? resource.displayName,
      skuName: str(fields, "skuName"),
      count: num(fields, spec.countField),
      metricWindow: str(fields, "metricWindow"),
      byteCount: num(fields, "byteCount"),
    }),
    decide: ({ id, skuName, count, metricWindow, byteCount }, { resource }) => {
      const evidence = (seenCount: number | null, window: string | null) => ({
        resourceUri: resource.resourceUri,
        [spec.idField]: id,
        ...(spec.countBeforeSku
          ? { [spec.countField]: seenCount, skuName }
          : { skuName, [spec.countField]: seenCount }),
        metricWindow: window,
      });
      if (count === null) {
        return undetermined(spec.countCloser, evidence(null, null));
      }
      if (!metricWindow || byteCount === null) {
        return undetermined(METRICS_CLOSER, evidence(count, null));
      }
      const traffic = evidence(count, metricWindow);
      return count === 0 || byteCount === 0 ? fail(traffic, spec.savings()) : pass(traffic);
    },
  });
}

export const checkIdleLoadBalancers = idleTrafficCheck({
  checkId: IDLE_LOAD_BALANCERS,
  resourceType: "Microsoft.Network/loadBalancers",
  idField: "loadBalancerId",
  countField: "backendAddressCount",
  countCloser: "A load balancer read that includes backend address pools",
  savings: idleLbMonthlySavings,
});

export const checkIdleNatGateways = idleTrafficCheck({
  checkId: IDLE_NAT_GATEWAYS,
  resourceType: "Microsoft.Network/natGateways",
  idField: "natGatewayId",
  countField: "attachedSubnetCount",
  countBeforeSku: true,
  countCloser: "A NAT gateway read that includes subnets",
  savings: idleNatMonthlySavings,
});
