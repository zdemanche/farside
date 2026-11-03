import type { InventoryRecord } from "@farside/scan-contracts";

export type EstateOverview = {
  empty: boolean;
  resourceTotal: number;
  noOwnerTotal: number;
  coverage: { assessed: number; unassessed: number; undetermined: number };
  healthScore: number | null;
};

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
  date: string;
  kind: string;
  title: string;
  source: string;
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

export type DataSource = {
  readonly mode: "demo" | "api";
  overview(signal?: AbortSignal): Promise<EstateOverview>;
  inventory(signal?: AbortSignal): Promise<InventoryRecord[]>;
  issues(signal?: AbortSignal): Promise<IssueRow[]>;
  scans(signal?: AbortSignal): Promise<ScanRow[]>;
  scan(id: string, signal?: AbortSignal): Promise<ScanRow>;
  blindSpots(signal?: AbortSignal): Promise<BlindSpotsView>;
  recovery(signal?: AbortSignal): Promise<RecoveryView>;
  lifecycle(signal?: AbortSignal): Promise<LifecycleView>;
  settings(signal?: AbortSignal): Promise<OrgSettings>;
  saveSettings(settings: OrgSettings, signal?: AbortSignal): Promise<OrgSettings>;
  connect(input: ConnectInput, signal?: AbortSignal): Promise<ConnectResult>;
};
