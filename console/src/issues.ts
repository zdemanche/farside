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
];
