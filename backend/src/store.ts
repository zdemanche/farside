import type { Cloud, Finding, Inventory } from "@farside/scan-contracts";
import type { AlertAnalysis } from "./alerts.js";
import type { Contract } from "./billing.js";
import type { BudgetSnapshot } from "./budgets.js";
import { systemClock, type Clock } from "./clock.js";
import type { CommitmentSnapshot } from "./commitments.js";
import type { CostSnapshot } from "./cost.js";
import type { CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import type { StoredIssue } from "./issues.js";
import { DeletedOrgError, type DeletionRecord } from "./offboard.js";
import {
  applyCommitments,
  applyCost,
  applyCoverage,
  deletionRecordFor,
  dropSubscription,
  emptyOrg,
  pruneScans,
  retagInventories,
  RunningScans,
  rowsPurged,
  sweepRetention,
} from "./org-ops.js";
import { DEFAULT_CLOUD } from "./providers/index.js";
import { presentRoles, probeRoles } from "./role-probe.js";
import {
  MAX_SCANS_PER_ORG,
  SUBSCRIPTION_DISCONNECTED,
  type AggregateName,
  type Connection,
  type ConnectionInput,
  type ConnectionPatch,
  type OrgRepository,
  type OrgState,
  type OrgView,
  type ScanMergeDraft,
  type Sequence,
} from "./repository.js";
import { nextClaim, type ClaimOptions, type ClaimResult, type OrgClaim } from "./org-claim.js";
import type { ScanJob } from "./scans.js";
import type { ScheduleState } from "./scheduler.js";
import { assertNoSecrets, markVerified, markVerifiedAll } from "./secrets.js";
import type { OrgSettings } from "./settings.js";

export { MAX_SCANS_PER_ORG, SUBSCRIPTION_DISCONNECTED };
export type { Connection, OrgState, OrgView };

export class MemoryStore implements OrgRepository {
  #orgs = new Map<string, OrgState>();
  #deletions = new Map<string, DeletionRecord>();
  #running = new RunningScans();
  #seeded = new Set<string>();
  #claims = new Map<string, OrgClaim>();

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

  view(orgId: string): OrgView {
    return this.org(orgId);
  }

  snapshot(orgId: string): OrgState {
    const copy = structuredClone(this.org(orgId));
    assertNoSecrets(copy);
    return copy;
  }

  costsOf(orgId: string): CostSnapshot[] {
    return Object.values(this.org(orgId).costs);
  }

  orgRows(orgId: string): number {
    return Object.entries(rowsPurged(this.#orgs.get(orgId))).reduce(
      (sum, [kind, count]) => (kind === "settings" ? sum : sum + count),
      0,
    );
  }

  async read<K extends AggregateName>(orgId: string, ...keys: K[]): Promise<Pick<OrgView, K>> {
    const org = this.org(orgId);
    return Object.fromEntries(keys.map((key) => [key, org[key]])) as Pick<OrgView, K>;
  }

  trackScan(orgId: string): { signal: AbortSignal; release: () => void } {
    return this.#running.track(orgId);
  }

  async orgIds(): Promise<string[]> {
    return [...this.#orgs.keys()];
  }

  async hasOrg(orgId: string): Promise<boolean> {
    return this.#orgs.has(orgId);
  }

  async deletion(orgId: string): Promise<DeletionRecord | null> {
    return this.#deletions.get(orgId) ?? null;
  }

  async offboard(
    orgId: string,
    now: string = this.clock(),
    trigger: DeletionRecord["trigger"] = "customer",
    requestedBy: string = trigger === "retention" ? "system" : "unknown",
  ): Promise<DeletionRecord> {
    const existing = this.#deletions.get(orgId);
    if (existing) {
      return existing;
    }
    const record = deletionRecordFor(this.#orgs.get(orgId), {
      orgId,
      now,
      trigger,
      requestedBy,
      runningScans: this.#running.abortAll(orgId),
    });
    assertNoSecrets(record);
    this.#orgs.delete(orgId);
    this.#claims.delete(orgId);
    this.#deletions.set(orgId, record);
    return record;
  }

  sweepRetention(now: string = this.clock(), onlyOrgId?: string): Promise<DeletionRecord[]> {
    return sweepRetention(this, now, onlyOrgId);
  }

  async repurgeDeleted(_now?: string): Promise<number> {
    return 0;
  }

  async nextSequence(orgId: string, kind: Sequence): Promise<number> {
    const { sequences } = this.org(orgId);
    sequences[kind] += 1;
    return sequences[kind];
  }

  async putInventory(orgId: string, inventory: Inventory): Promise<Inventory> {
    assertNoSecrets(inventory);
    markVerified(inventory);
    const org = this.org(orgId);
    org.inventories[inventory.cloud] = inventory;
    org.inventory = inventory;
    return inventory;
  }

  async putConnection(orgId: string, input: ConnectionInput, fixedId?: string): Promise<Connection> {
    assertNoSecrets(input);
    const existing = fixedId === undefined ? undefined : this.org(orgId).connections.find((item) => item.id === fixedId);
    if (existing) {
      return existing;
    }
    const cloud = input.cloud ?? DEFAULT_CLOUD;
    const probed = probeRoles(cloud, input.grantedRoles ?? presentRoles(cloud));
    const connection: Connection = {
      id: fixedId ?? `conn-${await this.nextSequence(orgId, "connection")}`,
      cloud,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      roles: probed.roles,
      missingRoles: probed.missingRoles,
      createdAt: this.clock(),
      healthy: probed.healthy,
    };
    markVerified(connection);
    const org = this.org(orgId);
    org.connections.push(connection);
    if (fixedId !== undefined) {
      org.sequences.connection = Math.max(org.sequences.connection, Number(fixedId.slice(fixedId.lastIndexOf("-") + 1)) || 0);
    }
    return connection;
  }

  async putCoverage(orgId: string, coverage: CoverageEntry[]): Promise<CoverageEntry[]> {
    assertNoSecrets(coverage);
    const org = this.org(orgId);
    applyCoverage(org, coverage);
    return org.coverage;
  }

  async putFindings(orgId: string, findings: Finding[]): Promise<Finding[]> {
    assertNoSecrets(findings);
    markVerifiedAll(findings);
    this.org(orgId).findings = findings;
    return findings;
  }

  async putFacts(orgId: string, facts: ResourceFacts[]): Promise<ResourceFacts[]> {
    assertNoSecrets(facts);
    this.org(orgId).facts = facts;
    return facts;
  }

  async putIssues(orgId: string, issues: StoredIssue[]): Promise<StoredIssue[]> {
    assertNoSecrets(issues);
    markVerifiedAll(issues);
    this.org(orgId).issues = issues;
    return issues;
  }

  async putCost(
    orgId: string,
    cost: CostSnapshot | null,
    subscriptionId: string | undefined = cost?.subscriptionId,
  ): Promise<CostSnapshot | null> {
    if (cost) {
      assertNoSecrets(cost);
    }
    applyCost(this.org(orgId), cost, subscriptionId);
    return cost;
  }

  async putCommitments(
    orgId: string,
    commitments: CommitmentSnapshot | null,
    subscriptionId: string | undefined = commitments?.subscriptionId,
  ): Promise<CommitmentSnapshot | null> {
    if (commitments) {
      assertNoSecrets(commitments);
    }
    applyCommitments(this.org(orgId), commitments, subscriptionId);
    return commitments;
  }

  async putBudgets(orgId: string, budgets: BudgetSnapshot | null): Promise<BudgetSnapshot | null> {
    if (budgets) {
      assertNoSecrets(budgets);
    }
    this.org(orgId).budgets = budgets;
    return budgets;
  }

  async putAlerts(orgId: string, alerts: AlertAnalysis | null): Promise<AlertAnalysis | null> {
    if (alerts) {
      assertNoSecrets(alerts);
    }
    this.org(orgId).alerts = alerts;
    return alerts;
  }

  async putSettings(orgId: string, settings: OrgSettings): Promise<OrgSettings> {
    assertNoSecrets(settings);
    const org = this.org(orgId);
    org.settings = settings;
    retagInventories(org, settings.ownerTagKey);
    return settings;
  }

  async putContract(orgId: string, contract: Contract | null): Promise<Contract | null> {
    if (contract) {
      assertNoSecrets(contract);
    }
    this.org(orgId).contract = contract;
    return contract;
  }

  async updateSchedule(
    orgId: string,
    mutate: (schedule: ScheduleState, settings: OrgSettings) => void,
  ): Promise<ScheduleState> {
    const { schedule, settings } = this.org(orgId);
    mutate(schedule, settings);
    return schedule;
  }

  async putJob(input: Omit<ScanJob, "id">, fixedId?: string): Promise<ScanJob> {
    assertNoSecrets(input);
    const existing = fixedId === undefined ? undefined : this.org(input.orgId).scans.find((item) => item.id === fixedId);
    if (existing) {
      return existing;
    }
    const job: ScanJob = { ...input, id: fixedId ?? `scan-${await this.nextSequence(input.orgId, "scan")}` };
    const org = this.org(input.orgId);
    markVerified(job);
    org.scans.push(job);
    if (fixedId !== undefined) {
      org.sequences.scan = Math.max(org.sequences.scan, Number(fixedId.slice(fixedId.lastIndexOf("-") + 1)) || 0);
    }
    if (org.scans.length > MAX_SCANS_PER_ORG) {
      org.scans = pruneScans(org.scans);
    }
    return job;
  }

  async getJob(orgId: string, jobId: string): Promise<ScanJob | undefined> {
    return this.org(orgId).scans.find((job) => job.id === jobId);
  }

  async patchJob(orgId: string, jobId: string, patch: Partial<ScanJob>): Promise<ScanJob> {
    const org = this.org(orgId);
    const index = org.scans.findIndex((job) => job.id === jobId);
    const current = org.scans[index];
    if (index < 0 || !current) {
      throw new Error(`scan ${jobId} missing`);
    }
    const next = { ...current, ...patch, id: current.id, orgId: current.orgId };
    assertNoSecrets(next);
    markVerified(next);
    org.scans[index] = next;
    return next;
  }

  async runningScan(orgId: string, subscriptionId: string): Promise<ScanJob | undefined> {
    return this.org(orgId).scans.find(
      (job) =>
        job.subscriptionId === subscriptionId && (job.status === "queued" || job.status === "running"),
    );
  }

  async mergeScan(orgId: string, cloud: Cloud, merge: (draft: ScanMergeDraft) => void): Promise<void> {
    const org = this.org(orgId);
    const draft: ScanMergeDraft = {
      inventories: { ...org.inventories },
      facts: org.facts,
      findings: org.findings,
      coverage: org.coverage,
      issues: org.issues,
      cost: org.cost,
      costs: org.costs,
    };
    merge(draft);
    const inventory = draft.inventories[cloud];
    assertNoSecrets({ inventory, facts: draft.facts, findings: draft.findings, coverage: draft.coverage, issues: draft.issues });
    if (inventory) {
      markVerified(inventory);
      org.inventory = inventory;
    }
    markVerifiedAll(draft.findings);
    markVerifiedAll(draft.issues);
    org.inventories = draft.inventories;
    org.facts = draft.facts;
    org.findings = draft.findings;
    org.coverage = draft.coverage;
    org.issues = draft.issues;
    org.cost = draft.cost;
  }

  async seeded(orgId: string): Promise<boolean> {
    return this.#seeded.has(orgId);
  }

  async markSeeded(orgId: string): Promise<void> {
    this.org(orgId);
    this.#seeded.add(orgId);
  }

  async orgClaim(orgId: string): Promise<OrgClaim | null> {
    this.org(orgId);
    const claim = this.#claims.get(orgId);
    return claim ? structuredClone(claim) : null;
  }

  async claimOrg(orgId: string, actorId: string, options: ClaimOptions = {}): Promise<ClaimResult> {
    this.org(orgId);
    const { result, write } = nextClaim(this.#claims.get(orgId) ?? null, {
      orgId,
      actorId,
      now: this.clock(),
      mayOwn: options.mayOwn !== false,
    });
    if (write && result.claim) {
      assertNoSecrets(result.claim);
      this.#claims.set(orgId, structuredClone(result.claim));
    }
    return result.claim ? { ...result, claim: structuredClone(result.claim) } : result;
  }

  async isConnected(orgId: string, subscriptionId: string): Promise<boolean> {
    const target = subscriptionId.toLowerCase();
    return this.org(orgId).connections.some((item) => item.subscriptionId.toLowerCase() === target);
  }

  async patchConnection(
    orgId: string,
    connectionId: string,
    patch: ConnectionPatch,
  ): Promise<Connection | null> {
    const connection = this.org(orgId).connections.find((item) => item.id === connectionId);
    if (!connection) {
      return null;
    }
    if (patch.healthy !== undefined) {
      connection.healthy = patch.healthy;
    }
    if (patch.roles !== undefined) {
      connection.roles = patch.roles;
    }
    if (patch.missingRoles !== undefined) {
      connection.missingRoles = patch.missingRoles;
    }
    assertNoSecrets(connection);
    markVerified(connection);
    return connection;
  }

  async purgeSubscription(orgId: string, subscriptionId: string): Promise<void> {
    const org = this.org(orgId);
    const target = subscriptionId.toLowerCase();
    if (!org.connections.some((connection) => connection.subscriptionId.toLowerCase() === target)) {
      dropSubscription(org, subscriptionId);
    }
  }

  async deleteConnection(orgId: string, connectionId: string): Promise<boolean> {
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
      dropSubscription(org, removed.subscriptionId);
    }
    return true;
  }
}

export async function runRetentionSweep(
  store: OrgRepository,
  clock: Clock = store.clock,
): Promise<DeletionRecord[]> {
  return store.sweepRetention(clock());
}
