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
  cloud: Cloud;
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
  cloud: Cloud;
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
  cloud: Cloud;
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

export type ConnectInput = { tenantId: string; subscriptionId: string; cloud?: Cloud };

export type RoleGap = { role: string; required: boolean };

export type ConnectResult = {
  scanStarted: boolean;
  attention: string | null;
  /** Roles the connection lacks; null when they could not be checked. Absent in demo mode. */
  roleGaps?: RoleGap[] | null;
};

export type SpendFigure = {
  serviceName: string;
  costAmount: string;
  provisional: boolean;
  periodStart: string;
  periodEnd: string;
};

export type ReservationUse = {
  reservationId: string;
  skuName: string;
  utilisationPercent: number;
  expiryDate: string;
};

export type SavingsPlanUse = {
  savingsPlanId: string;
  committedAmount: string;
  usedAmount: string;
  utilisationPercent: number;
  expiryDate: string;
  currency: string;
};

export type SpendChange = {
  serviceName: string;
  currentMonthCost: string;
  previousMonthCost: string;
  deltaAmount: string;
  deltaPercent: string;
};

export type WasteItem = {
  cloud: Cloud;
  checkId: string;
  resourceId: string;
  subscriptionId: string;
  evidence: Record<string, string | number | boolean | null>;
  savings: { min: string; max: string; currency: string };
  /** Hash link to the stored issue; the backend builds it from the issue identity. */
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
    reservations: ReservationUse[];
    savingsPlans: SavingsPlanUse[];
    noneFound: { reservations: boolean; savingsPlans: boolean };
    harvestStatus?: "unverified";
  } | null;
  waste: WasteItem[];
  history: {
    days: number | null;
    firstDay: string | null;
    daysNeeded: number | null;
    closer: string | null;
  };
  totals: {
    min: string;
    max: string;
    currency: string;
    assessedCount: number;
    unassessedScopes: number;
  };
};

export type HeadlineStatus = "ok" | "not_assessed" | "not_supported";

export type HeadlineValue =
  | { amount: string | null; currency: string }
  | { min: string; max: string; currency: string }
  | { unprotected: number; production: number; undetermined: number }
  | { count: number }
  | { byCloud: Record<string, HeadlineValue>; mixedCurrencies: boolean };

export type HeadlineFigure = {
  id: "monthlyCost" | "waste" | "backup" | "lifecycle" | "unseen";
  label: string;
  href: string;
  status: HeadlineStatus;
  value: HeadlineValue | null;
};

/** Read model of GET /v1/orgs/:orgId/headline. */
export type Headline = { sentence: string; figures: HeadlineFigure[] };

export type ContractState = "active" | "warning" | "grace" | "paused" | "retaining" | "ended";

/** Read model of GET /v1/orgs/:orgId/contract. Farside holds no card data. */
export type BillingView = {
  contract: {
    plan: string;
    startDate: string;
    endDate: string | null;
    state: ContractState;
    amountDue: string;
    currency: string;
    unpaidAt: string | null;
    stateChangedAt: string;
  };
  canScan: boolean;
  invoices: never[];
  retainUntil: string | null;
};

export type GrantToRemove = { kind: string; name: string; optional?: boolean };

/** Read model of GET /v1/orgs/:orgId/deletion and the POST /offboard result. */
export type DeletionView = {
  orgId: string;
  requestedBy: string;
  deletedAt: string;
  rowsPurged: Record<string, number>;
  connectionsRemoved: number;
  scansStopped: number;
  scheduleCancelled: boolean;
  accountClosureAt: string | null;
  trigger: "customer" | "retention";
  grantsToRemove: GrantToRemove[];
};

export type ExportKind = "issues" | "inventory" | "cost";

export type ExportFile = { filename: string; content: string };

export type DataSource = {
  readonly mode: "demo" | "api";
  readonly orgId: string;
  /** The single cloud every read is limited to; absent when showing all clouds. */
  readonly cloud?: Cloud;
  /** Absent when the source cannot produce a farside-export/1 file (demo mode). */
  exportFile?(
    kind: ExportKind,
    signal?: AbortSignal,
    options?: { allClouds?: boolean },
  ): Promise<ExportFile>;
  overview(signal?: AbortSignal): Promise<EstateOverview>;
  inventory(signal?: AbortSignal): Promise<InventoryRow[]>;
  issues(signal?: AbortSignal): Promise<IssueRow[]>;
  costWaste(signal?: AbortSignal): Promise<CostWasteView>;
  headline(signal?: AbortSignal): Promise<Headline>;
  /** Rejects with a not-found DataError when the org has no contract yet. */
  billing(signal?: AbortSignal): Promise<BillingView>;
  /** Null until the org has been offboarded. */
  deletion(signal?: AbortSignal): Promise<DeletionView | null>;
  /** Requires the customer to confirm and to have been offered the export. */
  offboard(signal?: AbortSignal): Promise<DeletionView>;
  scans(signal?: AbortSignal): Promise<ScanRow[]>;
  scan(id: string, signal?: AbortSignal): Promise<ScanRow>;
  blindSpots(signal?: AbortSignal): Promise<BlindSpotsView>;
  recovery(signal?: AbortSignal): Promise<RecoveryView>;
  lifecycle(signal?: AbortSignal): Promise<LifecycleView>;
  settings(signal?: AbortSignal): Promise<OrgSettings>;
  saveSettings(settings: OrgSettings, signal?: AbortSignal): Promise<OrgSettings>;
  connect(input: ConnectInput, signal?: AbortSignal): Promise<ConnectResult>;
};

/** GET /v1/orgs/:orgId/claim: whether the org is claimed and the caller's role in it. */
export type ClaimView = {
  orgId: string;
  claimed: boolean;
  claimedAt: string | null;
  role: "owner" | "member" | null;
  member: boolean;
  owner: boolean;
  memberCount: number;
};
