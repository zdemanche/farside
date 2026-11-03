import { CLOUDS, type Cloud, type Finding, type Inventory } from "@farside/scan-contracts";
import { systemClock, type Clock } from "./clock.js";
import type { CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import type { StoredIssue } from "./issues.js";
import { applyOwnerTag } from "./inventory.js";
import { REQUIRED_AZURE_ROLES } from "./roles.js";
import type { AlertAnalysis } from "./alerts.js";
import type { Contract } from "./billing.js";
import type { BudgetSnapshot } from "./budgets.js";
import type { CommitmentSnapshot } from "./commitments.js";
import type { CostSnapshot } from "./cost.js";
import { DeletedOrgError, type DeletionRecord } from "./offboard.js";
import type { ScanJob } from "./scans.js";
import { emptySchedule, type ScheduleState } from "./scheduler.js";
import { assertNoSecrets } from "./secrets.js";
import { DEFAULT_SETTINGS, type OrgSettings } from "./settings.js";

export type Connection = {
  id: string;
  tenantId: string;
  subscriptionId: string;
  roles: string[];
  createdAt: string;
  healthy: boolean;
};

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
  commitments: CommitmentSnapshot | null;
  budgets: BudgetSnapshot | null;
  alerts: AlertAnalysis | null;
  schedule: ScheduleState;
  contract: Contract | null;
};

function emptyOrg(now: string): OrgState {
  return {
    connections: [],
    inventory: null,
    inventories: {},
    coverage: [],
    findings: [],
    settings: { ...DEFAULT_SETTINGS, updatedAt: now },
    scans: [],
    facts: [],
    issues: [],
    cost: null,
    commitments: null,
    budgets: null,
    alerts: null,
    schedule: emptySchedule(),
    contract: null,
  };
}

export class MemoryStore {
  #orgs = new Map<string, OrgState>();
  #deletions = new Map<string, DeletionRecord>();

  constructor(readonly clock: Clock = systemClock) {}

  org(orgId: string): OrgState {
    if (this.#deletions.has(orgId)) {
      throw new DeletedOrgError(orgId);
    }
    const existing = this.#orgs.get(orgId);
    if (existing) {
      return existing;
    }
    const created = emptyOrg(this.clock());
    this.#orgs.set(orgId, created);
    return created;
  }

  hasOrg(orgId: string): boolean {
    return this.#orgs.has(orgId);
  }

  deletion(orgId: string): DeletionRecord | null {
    return this.#deletions.get(orgId) ?? null;
  }

  orgRows(orgId: string): number {
    const org = this.#orgs.get(orgId);
    if (!org) {
      return 0;
    }
    return (
      org.connections.length +
      Object.keys(org.inventories).length +
      (org.inventory && !org.inventories[org.inventory.cloud] ? 1 : 0) +
      org.coverage.length +
      org.findings.length +
      org.scans.length +
      org.facts.length +
      org.issues.length +
      (org.cost ? 1 : 0) +
      (org.commitments ? 1 : 0) +
      (org.budgets ? 1 : 0) +
      (org.alerts ? 1 : 0) +
      (org.contract ? 1 : 0)
    );
  }

  offboard(orgId: string, now: string = this.clock()): DeletionRecord {
    const existing = this.#deletions.get(orgId);
    if (existing) {
      return existing;
    }
    const org = this.#orgs.get(orgId);
    const connectionsRemoved = org?.connections.length ?? 0;
    const schedulePending = Boolean(
      org && org.settings.scanScheduleEnabled && org.schedule.nextRunAt,
    );
    const record: DeletionRecord = {
      orgId,
      deletedAt: now,
      connectionsRemoved,
      scansStopped: true,
      scheduleCancelled: schedulePending || Boolean(org?.settings.scanScheduleEnabled),
      accountClosureAt: null,
    };
    assertNoSecrets(record);
    this.#orgs.delete(orgId);
    this.#deletions.set(orgId, record);
    return record;
  }

  snapshot(orgId: string): OrgState {
    const copy = structuredClone(this.org(orgId));
    assertNoSecrets(copy);
    return copy;
  }

  putInventory(orgId: string, inventory: Inventory): Inventory {
    assertNoSecrets(inventory);
    const org = this.org(orgId);
    org.inventories[inventory.cloud] = inventory;
    org.inventory = inventory;
    return inventory;
  }

  inventoriesOf(orgId: string, cloud?: Cloud): Inventory[] {
    const org = this.org(orgId);
    const stored = CLOUDS.flatMap((name) => {
      const inventory = org.inventories[name];
      return inventory ? [inventory] : [];
    });
    const pool = stored.length > 0 ? stored : org.inventory ? [org.inventory] : [];
    return pool.filter((inventory) => cloud == null || inventory.cloud === cloud);
  }

  putConnection(
    orgId: string,
    input: { tenantId: string; subscriptionId: string },
  ): Connection {
    assertNoSecrets(input);
    const connection: Connection = {
      id: `conn-${this.org(orgId).connections.length + 1}`,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      roles: [...REQUIRED_AZURE_ROLES],
      createdAt: this.clock(),
      healthy: true,
    };
    this.org(orgId).connections.push(connection);
    return connection;
  }

  putCoverage(orgId: string, coverage: CoverageEntry[]): CoverageEntry[] {
    assertNoSecrets(coverage);
    this.org(orgId).coverage = coverage;
    return coverage;
  }

  putFindings(orgId: string, findings: Finding[]): Finding[] {
    assertNoSecrets(findings);
    this.org(orgId).findings = findings;
    return findings;
  }

  putFacts(orgId: string, facts: ResourceFacts[]): ResourceFacts[] {
    assertNoSecrets(facts);
    this.org(orgId).facts = facts;
    return facts;
  }

  putIssues(orgId: string, issues: StoredIssue[]): StoredIssue[] {
    assertNoSecrets(issues);
    this.org(orgId).issues = issues;
    return issues;
  }

  putCost(orgId: string, cost: CostSnapshot | null): CostSnapshot | null {
    if (cost) {
      assertNoSecrets(cost);
    }
    this.org(orgId).cost = cost;
    return cost;
  }

  putCommitments(orgId: string, commitments: CommitmentSnapshot | null): CommitmentSnapshot | null {
    if (commitments) {
      assertNoSecrets(commitments);
    }
    this.org(orgId).commitments = commitments;
    return commitments;
  }

  putBudgets(orgId: string, budgets: BudgetSnapshot | null): BudgetSnapshot | null {
    if (budgets) {
      assertNoSecrets(budgets);
    }
    this.org(orgId).budgets = budgets;
    return budgets;
  }

  putAlerts(orgId: string, alerts: AlertAnalysis | null): AlertAnalysis | null {
    if (alerts) {
      assertNoSecrets(alerts);
    }
    this.org(orgId).alerts = alerts;
    return alerts;
  }

  putSettings(orgId: string, settings: OrgSettings): OrgSettings {
    assertNoSecrets(settings);
    const org = this.org(orgId);
    org.settings = settings;
    for (const cloud of CLOUDS) {
      const inventory = org.inventories[cloud];
      if (inventory) {
        org.inventories[cloud] = applyOwnerTag(inventory, settings.ownerTagKey);
      }
    }
    if (org.inventory) {
      org.inventory = applyOwnerTag(org.inventory, settings.ownerTagKey);
    }
    return settings;
  }

  putContract(orgId: string, contract: Contract | null): Contract | null {
    if (contract) {
      assertNoSecrets(contract);
    }
    this.org(orgId).contract = contract;
    return contract;
  }

  putJob(input: Omit<ScanJob, "id">): ScanJob {
    assertNoSecrets(input);
    const job: ScanJob = { ...input, id: `scan-${this.org(input.orgId).scans.length + 1}` };
    this.org(input.orgId).scans.push(job);
    return job;
  }

  getJob(orgId: string, jobId: string): ScanJob | undefined {
    return this.org(orgId).scans.find((job) => job.id === jobId);
  }

  patchJob(orgId: string, jobId: string, patch: Partial<ScanJob>): ScanJob {
    const org = this.org(orgId);
    const index = org.scans.findIndex((job) => job.id === jobId);
    const current = org.scans[index];
    if (index < 0 || !current) {
      throw new Error(`scan ${jobId} missing`);
    }
    const next = { ...current, ...patch, id: current.id, orgId: current.orgId };
    assertNoSecrets(next);
    org.scans[index] = next;
    return next;
  }

  runningScan(orgId: string, subscriptionId: string): ScanJob | undefined {
    return this.org(orgId).scans.find(
      (job) =>
        job.subscriptionId === subscriptionId &&
        (job.status === "queued" || job.status === "running"),
    );
  }

  patchConnection(orgId: string, connectionId: string, patch: { healthy: boolean }): Connection | null {
    const connection = this.org(orgId).connections.find((item) => item.id === connectionId);
    if (!connection) {
      return null;
    }
    connection.healthy = patch.healthy;
    assertNoSecrets(connection);
    return connection;
  }

  deleteConnection(orgId: string, connectionId: string): boolean {
    const org = this.org(orgId);
    const next = org.connections.filter((connection) => connection.id !== connectionId);
    if (next.length === org.connections.length) {
      return false;
    }
    org.connections = next;
    return true;
  }
}
