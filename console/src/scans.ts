export type ScanStatus = "queued" | "running" | "succeeded" | "failed";
export type ScanCheckState = "assessed" | "unassessed" | "undetermined";

export type ScanCheckRow = {
  checkId: string;
  state: ScanCheckState;
  reason?: string;
  closer?: string;
};

export type ScanCoverageSummary = {
  assessed: number;
  unassessed: number;
  undetermined: number;
};

export type ScanRow = {
  id: string;
  subscriptionId: string;
  status: ScanStatus;
  complete: boolean;
  current: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  progress: string;
  coverageSummary: ScanCoverageSummary;
  checks: ScanCheckRow[];
};

export const SCAN_CHECKS: ScanCheckRow[] = [
  { checkId: "azure-inventory-all-resources", state: "assessed" },
  { checkId: "azure-waste-unattached-disks", state: "assessed" },
  {
    checkId: "azure-waste-idle-load-balancers",
    state: "undetermined",
    reason: "No metric series for the window.",
    closer: "Monitoring Reader and a metric series over a longer window",
  },
  {
    checkId: "azure-cost-spend-by-service",
    state: "unassessed",
    reason: "This check has not run on this subscription yet.",
    closer: "Run a scan after connect, or wait for the unattended scan.",
  },
];

export const SCAN_ROWS: ScanRow[] = [
  {
    id: "scan-1",
    subscriptionId: "main",
    status: "succeeded",
    complete: true,
    current: true,
    startedAt: "1970-01-01T00:00:00.000Z",
    finishedAt: "1970-01-01T00:00:01.200Z",
    durationMs: 1200,
    error: null,
    progress: "Finished",
    coverageSummary: { assessed: 2, unassessed: 1, undetermined: 1 },
    checks: SCAN_CHECKS,
  },
  {
    id: "scan-2",
    subscriptionId: "main",
    status: "failed",
    complete: false,
    current: false,
    startedAt: "1970-01-01T00:00:02.000Z",
    finishedAt: "1970-01-01T00:00:02.400Z",
    durationMs: 400,
    error: "Resource Graph call failed",
    progress: "Failed",
    coverageSummary: { assessed: 1, unassessed: 1, undetermined: 0 },
    checks: [
      { checkId: "azure-inventory-all-resources", state: "assessed" },
      {
        checkId: "azure-waste-unattached-disks",
        state: "unassessed",
        reason: "Scan failed before this check ran.",
      },
    ],
  },
];

export const RUNNING_SCAN: ScanRow = {
  id: "scan-3",
  subscriptionId: "main",
  status: "running",
  complete: false,
  current: false,
  startedAt: "1970-01-01T00:00:03.000Z",
  finishedAt: null,
  durationMs: null,
  error: null,
  progress: "Harvesting inventory",
  coverageSummary: { assessed: 0, unassessed: 0, undetermined: 0 },
  checks: [],
};

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "in progress";
  }
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  return `${(durationMs / 1000).toFixed(1)} s`;
}

export function formatCoverage(summary: ScanCoverageSummary): string {
  return `${summary.assessed} assessed, ${summary.unassessed} unassessed, ${summary.undetermined} undetermined`;
}

export function completeRunningScans(rows: ScanRow[]): ScanRow[] {
  return rows.map((scan) => {
    if (scan.status !== "queued" && scan.status !== "running") {
      return { ...scan, current: false };
    }
    return {
      ...scan,
      status: "succeeded",
      complete: true,
      current: true,
      finishedAt: scan.startedAt ?? "1970-01-01T00:00:04.200Z",
      durationMs: 1200,
      progress: "Finished",
      coverageSummary: { assessed: 2, unassessed: 1, undetermined: 1 },
      checks: SCAN_CHECKS,
    };
  });
}
