export type IssueRow = {
  id: string;
  checkId: string;
  resourceId: string;
  evidence: string;
  savings: string;
};

export const ISSUE_ROWS: IssueRow[] = [
  {
    id: "disk-unattached",
    checkId: "azure-waste-unattached-disks",
    resourceId: "disk-unattached",
    evidence: "diskState Unattached, sizeGb 128, eastus",
    savings: "$8.00–$12.00 USD (Monthly list price of the unused disk SKU and size, as a range)",
  },
  {
    id: "snapshot-old",
    checkId: "azure-waste-old-snapshots",
    resourceId: "snapshot-old",
    evidence: "ageDays 90, retentionDays 30",
    savings: "$1.00–$3.00 USD (Monthly list price of snapshot storage for the retained size, as a range)",
  },
  {
    id: "pip-unassociated",
    checkId: "azure-waste-unassociated-public-ips",
    resourceId: "pip-unassociated",
    evidence: "associatedTo none",
    savings: "$3.00–$5.00 USD (Monthly list price of the unused public IP SKU, as a range)",
  },
  {
    id: "vm-stopped-allocated",
    checkId: "azure-waste-stopped-not-deallocated-vms",
    resourceId: "vm-stopped-allocated",
    evidence: "powerState stopped, vmSize Standard_B2s, eastus",
    savings:
      "$30.40–$45.60 USD (Monthly compute list price of the VM size while stopped-but-allocated, as a range)",
  },
  {
    id: "plan-empty",
    checkId: "azure-waste-empty-app-service-plans",
    resourceId: "plan-empty",
    evidence: "numberOfSites 0, skuName S1",
    savings: "$70.00–$105.00 USD (Monthly list price of the empty plan SKU, as a range)",
  },
  {
    id: "lb-idle",
    checkId: "azure-waste-idle-load-balancers",
    resourceId: "lb-idle",
    evidence: "backendAddressCount 0, metricWindow 7d",
    savings: "$18.00–$27.00 USD (Monthly list price of the unused load balancer SKU, as a range)",
  },
  {
    id: "nat-idle",
    checkId: "azure-waste-idle-nat-gateways",
    resourceId: "nat-idle",
    evidence: "attachedSubnetCount 0, metricWindow 7d",
    savings: "$32.00–$48.00 USD (Monthly list price of the unused NAT gateway, as a range)",
  },
];
