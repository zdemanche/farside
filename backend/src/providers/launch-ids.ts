export const AZURE_LAUNCH_CHECK_IDS = [
  "azure-inventory-all-resources",
  "azure-inventory-no-owner-tag",
  "azure-waste-unattached-disks",
  "azure-waste-unassociated-public-ips",
  "azure-waste-old-snapshots",
  "azure-waste-stopped-not-deallocated-vms",
  "azure-waste-empty-app-service-plans",
  "azure-waste-idle-load-balancers",
  "azure-waste-idle-nat-gateways",
  "azure-cost-spend-by-service",
  "azure-cost-month-on-month",
  "azure-cost-reservation-use",
  "azure-cost-savings-plan-use",
  "azure-cost-subscriptions-without-budgets",
  "azure-resilience-prod-vms-outside-backup",
  "azure-resilience-prod-sql-outside-backup",
  "azure-resilience-db-zone-or-geo",
  "azure-lifecycle-retiring-skus",
  "azure-lifecycle-expiring-app-service-certs",
  "azure-lifecycle-expiring-gateway-certs",
] as const;

export const GCP_LAUNCH_CHECK_IDS = [
  "gcp-inventory-all-assets",
  "gcp-inventory-no-owner-label",
  "gcp-waste-unattached-disks",
  "gcp-waste-unused-external-ips",
  "gcp-waste-old-snapshots-and-images",
  "gcp-waste-idle-vm-and-disk-recommendations",
  "gcp-cost-spend-by-service",
  "gcp-cost-committed-use",
  "gcp-resilience-sql-ha-or-backup",
  "gcp-lifecycle-sql-gke-support",
  "gcp-lifecycle-expiring-certs",
] as const;

export const AZURE_HARVEST_ASSESSED_CHECK_IDS: ReadonlySet<string> = new Set([
  "azure-inventory-all-resources",
  "azure-inventory-no-owner-tag",
]);

export const GCP_HARVEST_ASSESSED_CHECK_IDS: ReadonlySet<string> = new Set([
  "gcp-inventory-all-assets",
  "gcp-inventory-no-owner-label",
]);

export const HARVEST_DRIVEN_CHECK_IDS = [
  "azure-cost-spend-by-service",
  "azure-cost-month-on-month",
  "azure-cost-reservation-use",
  "azure-cost-savings-plan-use",
  "azure-cost-subscriptions-without-budgets",
] as const;
