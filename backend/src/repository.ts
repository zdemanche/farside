import type { Cloud, Finding, Inventory } from "@farside/scan-contracts";
import type { AlertAnalysis } from "./alerts.js";
import type { Contract } from "./billing.js";
import type { BudgetSnapshot } from "./budgets.js";
import type { Clock } from "./clock.js";
import type { CommitmentSnapshot } from "./commitments.js";
import type { CostSnapshot } from "./cost.js";
import type { CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import type { StoredIssue } from "./issues.js";
import type { DeletionRecord } from "./offboard.js";
import type { DeepReadonly } from "./readonly.js";
import type { ScanJob } from "./scans.js";
import type { ScheduleState } from "./scheduler.js";
import type { OrgSettings } from "./settings.js";

export type Connection = {
  id: string;
  cloud: Cloud;
  tenantId: string;
  subscriptionId: string;
  roles: string[];
  createdAt: string;
  healthy: boolean;
};

export type Sequence = "scan" | "schedule" | "connection";

export type OrgState = {
  connections: Connection[];
  inventory: Inventory | null;
  inventories: Partial<Record<Cloud, Inventory>>;
  coverage: CoverageEntry[];
  findings: Finding[];
  settings: OrgSettings;
  scans: ScanJob[];
  facts: ResourceFacts[];
  issues: StoredIssue[];
  cost: CostSnapshot | null;
  costs: Record<string, CostSnapshot>;
  commitments: CommitmentSnapshot | null;
  commitmentsBySubscription: Record<string, CommitmentSnapshot>;
  budgets: BudgetSnapshot | null;
  alerts: AlertAnalysis | null;
  schedule: ScheduleState;
  contract: Contract | null;
  sequences: Record<Sequence, number>;
};

export type OrgView = DeepReadonly<OrgState>;

export type AggregateName = Exclude<keyof OrgState, "sequences">;

export const MAX_SCANS_PER_ORG = 200;

export const SUBSCRIPTION_DISCONNECTED = "subscription disconnected";

export type ScanPage = { scans: ScanJob[]; next?: string };

export type ConnectionInput = { tenantId: string; subscriptionId: string; cloud?: Cloud };

export interface OrgRepository {
  readonly clock: Clock;

  read<K extends AggregateName>(orgId: string, ...keys: K[]): Promise<Pick<OrgView, K>>;

  hasOrg(orgId: string): Promise<boolean>;
  orgIds(): Promise<string[]>;
  deletion(orgId: string): Promise<DeletionRecord | null>;
  offboard(
    orgId: string,
    now?: string,
    trigger?: DeletionRecord["trigger"],
    requestedBy?: string,
  ): Promise<DeletionRecord>;
  sweepRetention(now?: string, onlyOrgId?: string): Promise<DeletionRecord[]>;
  trackScan(orgId: string): { signal: AbortSignal; release: () => void };

  nextSequence(orgId: string, kind: Sequence): Promise<number>;

  putConnection(orgId: string, input: ConnectionInput): Promise<Connection>;
  patchConnection(orgId: string, connectionId: string, patch: { healthy: boolean }): Promise<Connection | null>;
  deleteConnection(orgId: string, connectionId: string): Promise<boolean>;
  isConnected(orgId: string, subscriptionId: string): Promise<boolean>;

  putInventory(orgId: string, inventory: Inventory): Promise<Inventory>;
  putCoverage(orgId: string, coverage: CoverageEntry[]): Promise<CoverageEntry[]>;
  putFindings(orgId: string, findings: Finding[]): Promise<Finding[]>;
  putFacts(orgId: string, facts: ResourceFacts[]): Promise<ResourceFacts[]>;
  putIssues(orgId: string, issues: StoredIssue[]): Promise<StoredIssue[]>;
  putCost(orgId: string, cost: CostSnapshot | null, subscriptionId?: string): Promise<CostSnapshot | null>;
  putCommitments(
    orgId: string,
    commitments: CommitmentSnapshot | null,
    subscriptionId?: string,
  ): Promise<CommitmentSnapshot | null>;
  putBudgets(orgId: string, budgets: BudgetSnapshot | null): Promise<BudgetSnapshot | null>;
  putAlerts(orgId: string, alerts: AlertAnalysis | null): Promise<AlertAnalysis | null>;
  putSettings(orgId: string, settings: OrgSettings): Promise<OrgSettings>;
  putContract(orgId: string, contract: Contract | null): Promise<Contract | null>;
  updateSchedule(orgId: string, mutate: (schedule: ScheduleState) => void): Promise<ScheduleState>;

  putJob(input: Omit<ScanJob, "id">): Promise<ScanJob>;
  getJob(orgId: string, jobId: string): Promise<ScanJob | undefined>;
  patchJob(orgId: string, jobId: string, patch: Partial<ScanJob>): Promise<ScanJob>;
  runningScan(orgId: string, subscriptionId: string): Promise<ScanJob | undefined>;
  listScans(orgId: string, page?: { limit?: number; after?: string }): Promise<ScanPage>;
}
