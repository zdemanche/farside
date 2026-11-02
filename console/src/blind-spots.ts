import { HEALTH_SCORE_FORMULA, scoreHealth } from "@farside/scan-contracts";

export { HEALTH_SCORE_FORMULA };

export type BlindSpot = {
  id: string;
  checkId: string;
  state: "unassessed" | "undetermined";
  reason: string;
  closer: string;
};

export const BLIND_SPOT_ROWS: BlindSpot[] = [
  {
    id: "main:azure-waste-unattached-disks",
    checkId: "azure-waste-unattached-disks",
    state: "unassessed",
    reason: "This check has not run on this subscription yet.",
    closer: "Run a scan after connect, or wait for the unattended scan.",
  },
  {
    id: "main:azure-resilience-prod-vms-outside-backup",
    checkId: "azure-resilience-prod-vms-outside-backup",
    state: "undetermined",
    reason:
      "Farside is missing a required Azure role on this subscription, so this check did not finish.",
    closer: "Grant the missing read-only role listed on Connect, then run a scan.",
  },
  {
    id: "main:azure-cost-spend-by-service",
    checkId: "azure-cost-spend-by-service",
    state: "unassessed",
    reason: "Azure throttled the API call for this check, so Farside stopped short of a result.",
    closer: "Wait and run the scan again. The next unattended run will retry.",
  },
];

const coverage = {
  scopes: [
    {
      id: "main:azure-inventory-all-resources",
      checkId: "azure-inventory-all-resources",
      assessed: true,
    },
    {
      id: "main:azure-waste-unattached-disks",
      checkId: "azure-waste-unattached-disks",
      assessed: false,
    },
    {
      id: "main:azure-resilience-prod-vms-outside-backup",
      checkId: "azure-resilience-prod-vms-outside-backup",
      assessed: false,
    },
    {
      id: "main:azure-cost-spend-by-service",
      checkId: "azure-cost-spend-by-service",
      assessed: false,
    },
  ],
};

export const BLIND_SPOT_HEALTH = scoreHealth(coverage, []);
