export type IssueStatus = "open" | "closed" | "not_confirmed";

export type IssueRow = {
  id: string;
  checkId: string;
  resourceId: string;
  subscription: string;
  status: IssueStatus;
  evidence: string;
  savings: string;
  coverage: string;
  firstSeen: string;
  lastConfirmed: string;
  closingScanId?: string;
  notConfirmedReason?: string;
};

export const ISSUE_ROWS: IssueRow[] = [
  {
    id: "disk-unattached",
    checkId: "azure-waste-unattached-disks",
    resourceId: "disk-unattached",
    subscription: "main",
    status: "open",
    evidence: "diskState Unattached, sizeGb 128, eastus",
    savings: "$8.00–$12.00 USD (Monthly list price of the unused disk SKU and size, as a range)",
    coverage: "assessed",
    firstSeen: "1970-01-01T00:00:00.000Z",
    lastConfirmed: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "snapshot-old",
    checkId: "azure-waste-old-snapshots",
    resourceId: "snapshot-old",
    subscription: "main",
    status: "open",
    evidence: "ageDays 90, retentionDays 30",
    savings: "$1.00–$3.00 USD (Monthly list price of snapshot storage for the retained size, as a range)",
    coverage: "assessed",
    firstSeen: "1970-01-01T00:00:00.000Z",
    lastConfirmed: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "pip-unassociated",
    checkId: "azure-waste-unassociated-public-ips",
    resourceId: "pip-unassociated",
    subscription: "main",
    status: "open",
    evidence: "associatedTo none",
    savings: "$3.00–$5.00 USD (Monthly list price of the unused public IP SKU, as a range)",
    coverage: "assessed",
    firstSeen: "1970-01-01T00:00:00.000Z",
    lastConfirmed: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "vm-stopped-allocated",
    checkId: "azure-waste-stopped-not-deallocated-vms",
    resourceId: "vm-stopped-allocated",
    subscription: "main",
    status: "open",
    evidence: "powerState stopped, vmSize Standard_B2s, eastus",
    savings:
      "$30.40–$45.60 USD (Monthly compute list price of the VM size while stopped-but-allocated, as a range)",
    coverage: "assessed",
    firstSeen: "1970-01-01T00:00:00.000Z",
    lastConfirmed: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "plan-empty",
    checkId: "azure-waste-empty-app-service-plans",
    resourceId: "plan-empty",
    subscription: "main",
    status: "open",
    evidence: "numberOfSites 0, skuName S1",
    savings: "$70.00–$105.00 USD (Monthly list price of the empty plan SKU, as a range)",
    coverage: "assessed",
    firstSeen: "1970-01-01T00:00:00.000Z",
    lastConfirmed: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "lb-idle",
    checkId: "azure-waste-idle-load-balancers",
    resourceId: "lb-idle",
    subscription: "main",
    status: "open",
    evidence: "backendAddressCount 0, metricWindow 7d",
    savings: "$18.00–$27.00 USD (Monthly list price of the unused load balancer SKU, as a range)",
    coverage: "assessed",
    firstSeen: "1970-01-01T00:00:00.000Z",
    lastConfirmed: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "nat-idle",
    checkId: "azure-waste-idle-nat-gateways",
    resourceId: "nat-idle",
    subscription: "main",
    status: "open",
    evidence: "attachedSubnetCount 0, metricWindow 7d",
    savings: "$32.00–$48.00 USD (Monthly list price of the unused NAT gateway, as a range)",
    coverage: "assessed",
    firstSeen: "1970-01-01T00:00:00.000Z",
    lastConfirmed: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "disk-fixed",
    checkId: "azure-waste-unattached-disks",
    resourceId: "disk-fixed",
    subscription: "main",
    status: "closed",
    evidence: "diskState Unattached, then attached",
    savings: "$8.00–$12.00 USD (Monthly list price of the unused disk SKU and size, as a range)",
    coverage: "assessed",
    firstSeen: "1970-01-01T00:00:00.000Z",
    lastConfirmed: "1970-01-01T00:00:00.000Z",
    closingScanId: "scan-2",
  },
  {
    id: "disk-unconfirmed",
    checkId: "azure-waste-unattached-disks",
    resourceId: "disk-unconfirmed",
    subscription: "ghost",
    status: "not_confirmed",
    evidence: "diskState Unattached",
    savings: "$8.00–$12.00 USD (Monthly list price of the unused disk SKU and size, as a range)",
    coverage: "unassessed",
    firstSeen: "1970-01-01T00:00:00.000Z",
    lastConfirmed: "1970-01-01T00:00:00.000Z",
    notConfirmedReason: "This check has not run on this subscription yet.",
  },
];
