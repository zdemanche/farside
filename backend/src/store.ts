import { CLOUDS, type Cloud, type Finding, type Inventory } from "@farside/scan-contracts";
import { systemClock, type Clock } from "./clock.js";
import type { CoverageEntry } from "./coverage.js";
import { combineCosts, hasFigures, hasMixedCurrencies, markMixedCurrency, restoreAfterMixedCurrency } from "./cost-total.js";
import { scopeOf } from "./scope.js";
import type { ResourceFacts } from "./facts.js";
import type { StoredIssue } from "./issues.js";
import { applyOwnerTag } from "./inventory.js";
import { DEFAULT_CLOUD, providerFor } from "./providers/index.js";
import { DEMO_ORG_ID } from "./demo.js";
import type { AlertAnalysis } from "./alerts.js";
import { retentionElapsed, type Contract } from "./billing.js";
import type { BudgetSnapshot } from "./budgets.js";
import type { CommitmentSnapshot } from "./commitments.js";
import type { CostSnapshot } from "./cost.js";
import { DeletedOrgError, type DeletionRecord, type RowsPurged } from "./offboard.js";
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
  costs: Record<string, CostSnapshot>;
  commitments: CommitmentSnapshot | null;
  commitmentsBySubscription: Record<string, CommitmentSnapshot>;
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
    costs: {},
    commitments: null,
    commitmentsBySubscription: {},
    budgets: null,
    alerts: null,
    schedule: emptySchedule(),
    contract: null,
  };
}

export const SUBSCRIPTION_DISCONNECTED = "subscription disconnected";

function combineCommitments(snapshots: readonly CommitmentSnapshot[]): CommitmentSnapshot | null {
  const first = snapshots[0];
  if (!first || snapshots.length === 1) {
    return first ?? null;
  }
  return {
    ...first,
    subscriptionId: snapshots.map((item) => item.subscriptionId).join(","),
    billingScope: [...new Set(snapshots.map((item) => item.billingScope))].join(","),
    periodStart: snapshots.map((item) => item.periodStart).sort()[0] ?? first.periodStart,
    periodEnd: snapshots.map((item) => item.periodEnd).sort().at(-1) ?? first.periodEnd,
    reservations: snapshots.flatMap((item) => item.reservations),
    savingsPlans: snapshots.flatMap((item) => item.savingsPlans),
    noneFound: {
      reservations: snapshots.every((item) => item.noneFound.reservations),
      savingsPlans: snapshots.every((item) => item.noneFound.savingsPlans),
    },
  };
}

export class MemoryStore {
  #orgs = new Map<string, OrgState>();
  #deletions = new Map<string, DeletionRecord>();
  #runningScans = new Map<string, Set<AbortController>>();

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

  trackScan(orgId: string): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    const controllers = this.#runningScans.get(orgId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.#runningScans.set(orgId, controllers);
    return {
      signal: controller.signal,
      release: () => {
        controllers.delete(controller);
        if (controllers.size === 0 && this.#runningScans.get(orgId) === controllers) {
          this.#runningScans.delete(orgId);
        }
      },
    };
  }

  orgIds(): string[] {
    return [...this.#orgs.keys()];
  }

  hasOrg(orgId: string): boolean {
    return this.#orgs.has(orgId);
  }

  deletion(orgId: string): DeletionRecord | null {
    return this.#deletions.get(orgId) ?? null;
  }

  orgRows(orgId: string): number {
    return Object.entries(this.#rowsPurged(this.#orgs.get(orgId))).reduce(
      (sum, [kind, count]) => (kind === "settings" ? sum : sum + count),
      0,
    );
  }

  #rowsPurged(org: OrgState | undefined): RowsPurged {
    const inventories = [
      ...Object.values(org?.inventories ?? {}),
      ...(org?.inventory && !org.inventories[org.inventory.cloud] ? [org.inventory] : []),
    ];
    return {
      connections: org?.connections.length ?? 0,
      inventoryResources: inventories.reduce((sum, inventory) => sum + inventory.resources.length, 0),
      facts: org?.facts.length ?? 0,
      findings: org?.findings.length ?? 0,
      coverage: org?.coverage.length ?? 0,
      issues: org?.issues.length ?? 0,
      scans: org?.scans.length ?? 0,
      costSnapshots: Object.keys(org?.costs ?? {}).length,
      commitments: Object.keys(org?.commitmentsBySubscription ?? {}).length,
      budgets: org?.budgets ? 1 : 0,
      alerts: org?.alerts ? 1 : 0,
      settings: org ? 1 : 0,
      contract: org?.contract ? 1 : 0,
    };
  }

  offboard(
    orgId: string,
    now: string = this.clock(),
    trigger: DeletionRecord["trigger"] = "customer",
    requestedBy: string = trigger === "retention" ? "system" : "unknown",
  ): DeletionRecord {
    const existing = this.#deletions.get(orgId);
    if (existing) {
      return existing;
    }
    const org = this.#orgs.get(orgId);
    const connectionsRemoved = org?.connections.length ?? 0;
    const schedulePending = Boolean(
      org && org.settings.scanScheduleEnabled && org.schedule.nextRunAt,
    );
    const running = this.#runningScans.get(orgId) ?? new Set<AbortController>();
    const scansStopped = running.size + (org?.scans.filter((job) => job.status === "queued").length ?? 0);
    for (const controller of running) {
      controller.abort();
    }
    this.#runningScans.delete(orgId);
    const record: DeletionRecord = {
      orgId,
      requestedBy,
      deletedAt: now,
      rowsPurged: this.#rowsPurged(org),
      connectionsRemoved,
      scansStopped,
      scheduleCancelled: schedulePending || Boolean(org?.settings.scanScheduleEnabled),
      accountClosureAt: null,
      trigger,
    };
    assertNoSecrets(record);
    this.#orgs.delete(orgId);
    this.#deletions.set(orgId, record);
    return record;
  }

  sweepRetention(now: string = this.clock(), onlyOrgId?: string): DeletionRecord[] {
    const due = [...this.#orgs]
      .filter(
        ([orgId, org]) =>
          orgId !== DEMO_ORG_ID &&
          (onlyOrgId === undefined || orgId === onlyOrgId) &&
          org.contract !== null &&
          retentionElapsed(org.contract, now),
      )
      .map(([orgId]) => orgId);
    return due.map((orgId) => this.offboard(orgId, now, "retention"));
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
    input: { tenantId: string; subscriptionId: string; cloud?: Cloud },
  ): Connection {
    assertNoSecrets(input);
    const connection: Connection = {
      id: `conn-${this.org(orgId).connections.length + 1}`,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      roles: [...providerFor(input.cloud ?? DEFAULT_CLOUD).requiredRoles],
      createdAt: this.clock(),
      healthy: true,
    };
    this.org(orgId).connections.push(connection);
    return connection;
  }

  putCoverage(orgId: string, coverage: CoverageEntry[]): CoverageEntry[] {
    assertNoSecrets(coverage);
    const org = this.org(orgId);
    org.coverage = coverage;
    this.#refreshCost(org);
    return org.coverage;
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

  putCost(
    orgId: string,
    cost: CostSnapshot | null,
    subscriptionId: string | undefined = cost?.subscriptionId,
  ): CostSnapshot | null {
    if (cost) {
      assertNoSecrets(cost);
    }
    const org = this.org(orgId);
    if (subscriptionId === undefined) {
      org.costs = {};
    } else {
      delete org.costs[subscriptionId];
      if (cost) {
        org.costs[subscriptionId] = cost;
      }
    }
    this.#refreshCost(org);
    return cost;
  }

  #refreshCost(org: OrgState): void {
    const snapshots = Object.values(org.costs);
    org.cost = combineCosts(snapshots);
    org.coverage = hasMixedCurrencies(snapshots)
      ? markMixedCurrency(
          org.coverage,
          Object.keys(org.costs).filter((key) => org.costs[key] && hasFigures(org.costs[key])),
        )
      : restoreAfterMixedCurrency(org.coverage, org.costs);
  }

  costsOf(orgId: string): CostSnapshot[] {
    return Object.values(this.org(orgId).costs);
  }

  putCommitments(
    orgId: string,
    commitments: CommitmentSnapshot | null,
    subscriptionId: string | undefined = commitments?.subscriptionId,
  ): CommitmentSnapshot | null {
    if (commitments) {
      assertNoSecrets(commitments);
    }
    const org = this.org(orgId);
    if (subscriptionId === undefined) {
      org.commitmentsBySubscription = {};
    } else {
      delete org.commitmentsBySubscription[subscriptionId];
      if (commitments) {
        org.commitmentsBySubscription[subscriptionId] = commitments;
      }
    }
    org.commitments = combineCommitments(Object.values(org.commitmentsBySubscription));
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
        job.subscriptionId === subscriptionId && (job.status === "queued" || job.status === "running"),
    );
  }

  isConnected(orgId: string, subscriptionId: string): boolean {
    const target = subscriptionId.toLowerCase();
    return this.org(orgId).connections.some((item) => item.subscriptionId.toLowerCase() === target);
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

  #dropSubscription(org: OrgState, subscriptionId: string): void {
    const target = subscriptionId.toLowerCase();
    const inScope = (cloud: Cloud, resourceUri: string) => scopeOf(cloud, resourceUri).toLowerCase() === target;
    for (const cloud of CLOUDS) {
      const inventory = org.inventories[cloud];
      if (inventory) {
        org.inventories[cloud] = {
          ...inventory,
          resources: inventory.resources.filter((resource) => !inScope(cloud, resource.resourceUri)),
        };
      }
    }
    const latest = org.inventory;
    if (latest) {
      org.inventory = {
        ...latest,
        resources: latest.resources.filter((resource) => !inScope(latest.cloud, resource.resourceUri)),
      };
    }
    org.facts = org.facts.filter((row) => !CLOUDS.some((cloud) => inScope(cloud, row.resourceUri)));
    for (const key of Object.keys(org.costs)) {
      if (key.toLowerCase() === target) {
        delete org.costs[key];
      }
    }
    for (const key of Object.keys(org.commitmentsBySubscription)) {
      if (key.toLowerCase() === target) {
        delete org.commitmentsBySubscription[key];
      }
    }
    org.commitments = combineCommitments(Object.values(org.commitmentsBySubscription));
    const matches = (value: string) => value.toLowerCase() === target;
    org.findings = org.findings.filter((finding) => !matches(finding.scope.subscriptionOrProject));
    org.coverage = org.coverage.filter((entry) => !matches(entry.subscriptionOrProject));
    org.issues = org.issues.map((issue) => {
      if (!matches(issue.subscriptionOrProject) || issue.status === "closed") {
        return issue;
      }
      const { closingScanId: _closing, notConfirmedReason: _reason, ...rest } = issue;
      return { ...rest, status: "closed", closedReason: SUBSCRIPTION_DISCONNECTED };
    });
    this.#refreshCost(org);
  }

  deleteConnection(orgId: string, connectionId: string): boolean {
    const org = this.org(orgId);
    const next = org.connections.filter((connection) => connection.id !== connectionId);
    if (next.length === org.connections.length) {
      return false;
    }
    const removed = org.connections.find((connection) => connection.id === connectionId);
    org.connections = next;
    if (
      removed &&
      !next.some((connection) => connection.subscriptionId.toLowerCase() === removed.subscriptionId.toLowerCase())
    ) {
      this.#dropSubscription(org, removed.subscriptionId);
    }
    return true;
  }
}

export function runRetentionSweep(store: MemoryStore, clock: Clock = store.clock): DeletionRecord[] {
  return store.sweepRetention(clock());
}
