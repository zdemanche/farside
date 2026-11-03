export const BILLING_EXPORT_ROLE = "BigQuery access to the billing export";

export const BILLING_EXPORT_DATASET_CLOSER =
  "Enable the BigQuery billing export and grant the Farside workload read access";

export const BILLING_EXPORT_EMPTY_CLOSER = "At least one completed export day after enablement";

export const BILLING_EXPORT_STEPS = [
  "Enable the BigQuery billing export on the billing account linked to this project.",
  "Grant the Farside workload BigQuery access to the billing export dataset.",
  "Wait for the first completed export day. History starts that day and does not backfill.",
] as const;

export type BillingExportHarvest =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "empty"; enabledOn: string }
  | { state: "readable"; enabledOn: string; completedDays: string[] };

export type BillingExportOnboarding = {
  state: BillingExportHarvest["state"];
  costConnected: boolean;
  fillsForward: true;
  steps: readonly string[];
  closer?: string;
  startDate?: string;
  historyDays?: number;
  missingRole?: string;
};

export function detectBillingExport(harvest: BillingExportHarvest): BillingExportOnboarding {
  if (harvest.state === "absent") {
    return {
      state: "absent",
      costConnected: false,
      fillsForward: true,
      steps: BILLING_EXPORT_STEPS,
      closer: BILLING_EXPORT_DATASET_CLOSER,
    };
  }
  if (harvest.state === "unreadable") {
    return {
      state: "unreadable",
      costConnected: false,
      fillsForward: true,
      steps: BILLING_EXPORT_STEPS.slice(1),
      closer: BILLING_EXPORT_DATASET_CLOSER,
      missingRole: BILLING_EXPORT_ROLE,
    };
  }
  if (harvest.state === "empty") {
    return {
      state: "empty",
      costConnected: true,
      fillsForward: true,
      steps: [],
      closer: BILLING_EXPORT_EMPTY_CLOSER,
      startDate: harvest.enabledOn,
      historyDays: 0,
    };
  }
  return {
    state: "readable",
    costConnected: true,
    fillsForward: true,
    steps: [],
    startDate: harvest.enabledOn,
    historyDays: harvest.completedDays.length,
  };
}
