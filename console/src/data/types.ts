import type { Cloud, InventoryRecord } from "@farside/scan-contracts";

export type InventoryRow = InventoryRecord & {
  subscriptionOrProject: string;
  cloud?: Cloud;
};

export type EstateOverview = {
  empty: boolean;
  resourceTotal: number;
  noOwnerTotal: number;
  coverage: { assessed: number; unassessed: number; undetermined: number };
  healthScore: number | null;
};

export type Money = {
  min: string;
  max: string;
  currency: string;
  period: "month";
};

export type IssueStatus = "open" | "closed" | "not_confirmed";

export type IssueRow = {
  id: string;
  checkId: string;
  resourceId: string;
  subscription: string;
  status: IssueStatus;
  evidence: string;
  savings: Money | null;
  coverage: string;
  firstSeen: string;
  lastConfirmed: string;
  closingScanId?: string;
  notConfirmedReason?: string;
};

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
  durationMs: number | null;
  error: string | null;
  errorId?: string;
  coverageSummary: ScanCoverageSummary;
  checks: ScanCheckRow[];
};

export type BlindSpot = {
  id: string;
  checkId: string;
  state: "unassessed" | "undetermined";
  reason: string;
  closer: string;
};

export type BlindSpotsView = {
  spots: BlindSpot[];
  leftOut: number;
  total: number;
  formula: string;
};

export type RecoveryRow = {
  id: string;
  system: string;
  checkId: string;
  evidence: string;
  coverage: "assessed" | "undetermined";
};

export type RecoveryView = {
  rows: RecoveryRow[];
  unprotected: number;
  checked: number;
  undetermined: number;
};

export type LifecycleRow = {
  id: string;
  resourceId: string;
  date: string;
  kind: string;
  title: string;
  source: { vendor: string; href?: string };
};

export type LifecycleView = {
  rows: LifecycleRow[];
  within90: number;
};

export type OrgSettings = {
  ownerTagKey: string;
  productionTagKey: string;
  productionTagValue: string;
  snapshotRetentionDays: number;
  certExpiryFlagDays: number;
  scanScheduleEnabled: boolean;
  scanIntervalHours: number;
  scanRetryLimit: number;
};

export type ConnectInput = { tenantId: string; subscriptionId: string };

export type ConnectResult = { scanStarted: boolean; attention: string | null };

export type SpendFigure = { serviceName: string; costAmount: string; provisional: boolean };

export type SpendChange = {
  serviceName: string;
  currentMonthCost: string;
  previousMonthCost: string;
  deltaAmount: string;
  deltaPercent: string;
};

export type WasteItem = {
  checkId: string;
  resourceId: string;
  subscriptionId: string;
  evidence: Record<string, unknown>;
  savings: { min: string; max: string; currency: string };
  issueHref: string;
};

/** Read model of GET /v1/orgs/:orgId/cost-waste. */
export type CostWasteView = {
  readable: boolean;
  reason: string | null;
  spend: {
    currency: string;
    periodStart: string;
    periodEnd: string;
    provisionalDate: string | null;
    services: SpendFigure[];
    monthOnMonth: SpendChange[];
  } | null;
  floorBurst:
    { date: string; actual: string; floor: string; burst: string; currency: string }[] | null;
  commitments: {
    reservations: unknown[];
    savingsPlans: unknown[];
    noneFound: { reservations: boolean; savingsPlans: boolean };
    harvestStatus?: "unverified";
  } | null;
  waste: WasteItem[];
  totals: {
    min: string;
    max: string;
    currency: string;
    assessedCount: number;
    unassessedScopes: number;
  };
};

export type ExportKind = "issues" | "inventory" | "cost";

export type ExportFile = { filename: string; content: string };

export type DataSource = {
  readonly mode: "demo" | "api";
  readonly orgId: string;
  /** Absent when the source cannot produce a farside-export/1 file (demo mode). */
  exportFile?(kind: ExportKind, signal?: AbortSignal): Promise<ExportFile>;
  overview(signal?: AbortSignal): Promise<EstateOverview>;
  inventory(signal?: AbortSignal): Promise<InventoryRow[]>;
  issues(signal?: AbortSignal): Promise<IssueRow[]>;
  costWaste(signal?: AbortSignal): Promise<CostWasteView>;
  scans(signal?: AbortSignal): Promise<ScanRow[]>;
  scan(id: string, signal?: AbortSignal): Promise<ScanRow>;
  blindSpots(signal?: AbortSignal): Promise<BlindSpotsView>;
  recovery(signal?: AbortSignal): Promise<RecoveryView>;
  lifecycle(signal?: AbortSignal): Promise<LifecycleView>;
  settings(signal?: AbortSignal): Promise<OrgSettings>;
  saveSettings(settings: OrgSettings, signal?: AbortSignal): Promise<OrgSettings>;
  connect(input: ConnectInput, signal?: AbortSignal): Promise<ConnectResult>;
};
