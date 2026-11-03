import { CLOUDS, type Cloud } from "@farside/scan-contracts";
import type { CommitmentSnapshot } from "./commitments.js";
import type { CostSnapshot } from "./cost.js";
import type { CoverageEntry } from "./coverage.js";
import {
  combineCosts,
  hasFigures,
  hasMixedCurrencies,
  markMixedCurrency,
  restoreAfterMixedCurrency,
} from "./cost-total.js";
import { DEMO_ORG_ID } from "./demo.js";
import { retentionElapsed, type Contract } from "./billing.js";
import { applyOwnerTag } from "./inventory.js";
import { DeletedOrgError, type DeletionRecord, type RowsPurged } from "./offboard.js";
import { asMutable } from "./readonly.js";
import {
  MAX_SCANS_PER_ORG,
  SUBSCRIPTION_DISCONNECTED,
  type OrgRepository,
  type OrgState,
} from "./repository.js";
import { emptySchedule } from "./scheduler.js";
import { scopeOf } from "./scope.js";
import { markVerified, markVerifiedAll } from "./secrets.js";
import { DEFAULT_SETTINGS } from "./settings.js";

export type Draft<K extends keyof OrgState> = Pick<OrgState, K>;

export function emptyOrg(now: string): OrgState {
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
    sequences: { scan: 0, schedule: 0, connection: 0 },
  };
}

export function combineCommitments(snapshots: readonly CommitmentSnapshot[]): CommitmentSnapshot | null {
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

export function pruneScans<T extends { status: string; complete: boolean }>(scans: T[]): T[] {
  const current = [...scans].reverse().find((job) => job.status === "succeeded" && job.complete);
  let excess = scans.length - MAX_SCANS_PER_ORG;
  return scans.filter((job) => {
    const settled = job.status !== "queued" && job.status !== "running" && job !== current;
    if (excess > 0 && settled) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

export function refreshCost(org: Draft<"cost" | "costs" | "coverage">): void {
  const snapshots = Object.values(org.costs);
  org.cost = combineCosts(snapshots);
  org.coverage = hasMixedCurrencies(snapshots)
    ? markMixedCurrency(
        org.coverage,
        Object.keys(org.costs).filter((key) => org.costs[key] && hasFigures(org.costs[key])),
      )
    : restoreAfterMixedCurrency(org.coverage, org.costs);
}

export function applyCoverage(org: Draft<"cost" | "costs" | "coverage">, coverage: CoverageEntry[]): void {
  org.coverage = coverage;
  refreshCost(org);
}

export function applyCost(
  org: Draft<"cost" | "costs" | "coverage">,
  cost: CostSnapshot | null,
  subscriptionId: string | undefined,
): void {
  if (subscriptionId === undefined) {
    org.costs = {};
  } else {
    delete org.costs[subscriptionId];
    if (cost) {
      org.costs[subscriptionId] = cost;
    }
  }
  refreshCost(org);
}

export function applyCommitments(
  org: Draft<"commitments" | "commitmentsBySubscription">,
  commitments: CommitmentSnapshot | null,
  subscriptionId: string | undefined,
): void {
  if (subscriptionId === undefined) {
    org.commitmentsBySubscription = {};
  } else {
    delete org.commitmentsBySubscription[subscriptionId];
    if (commitments) {
      org.commitmentsBySubscription[subscriptionId] = commitments;
    }
  }
  org.commitments = combineCommitments(Object.values(org.commitmentsBySubscription));
}

export function retagInventories(org: Draft<"inventories" | "inventory">, ownerTagKey: string): void {
  for (const cloud of CLOUDS) {
    const inventory = org.inventories[cloud];
    if (inventory) {
      org.inventories[cloud] = markVerified(applyOwnerTag(inventory, ownerTagKey));
    }
  }
  if (org.inventory) {
    org.inventory = markVerified(applyOwnerTag(org.inventory, ownerTagKey));
  }
}

export type SubscriptionDraft = Draft<
  | "inventories"
  | "inventory"
  | "facts"
  | "cost"
  | "costs"
  | "commitments"
  | "commitmentsBySubscription"
  | "findings"
  | "coverage"
  | "issues"
>;

export function dropSubscription(org: SubscriptionDraft, subscriptionId: string): void {
  const target = subscriptionId.toLowerCase();
  const inScope = (cloud: Cloud, resourceUri: string) => scopeOf(cloud, resourceUri).toLowerCase() === target;
  for (const cloud of CLOUDS) {
    const inventory = org.inventories[cloud];
    if (inventory) {
      org.inventories[cloud] = markVerified({
        ...inventory,
        resources: inventory.resources.filter((resource) => !inScope(cloud, resource.resourceUri)),
      });
    }
  }
  const latest = org.inventory;
  if (latest) {
    org.inventory = markVerified({
      ...latest,
      resources: latest.resources.filter((resource) => !inScope(latest.cloud, resource.resourceUri)),
    });
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
  markVerifiedAll(org.issues);
  refreshCost(org);
}

export function rowsPurged(org: OrgState | undefined): RowsPurged {
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

export function deletionRecordFor(
  org: OrgState | undefined,
  input: {
    orgId: string;
    now: string;
    trigger: DeletionRecord["trigger"];
    requestedBy: string;
    runningScans: number;
  },
): DeletionRecord {
  const schedulePending = Boolean(org && org.settings.scanScheduleEnabled && org.schedule.nextRunAt);
  return {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    deletedAt: input.now,
    rowsPurged: rowsPurged(org),
    connectionsRemoved: org?.connections.length ?? 0,
    scansStopped: input.runningScans + (org?.scans.filter((job) => job.status === "queued").length ?? 0),
    scheduleCancelled: schedulePending || Boolean(org?.settings.scanScheduleEnabled),
    accountClosureAt: null,
    trigger: input.trigger,
  };
}

export class RunningScans {
  #running = new Map<string, Set<AbortController>>();

  track(orgId: string): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    const controllers = this.#running.get(orgId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.#running.set(orgId, controllers);
    return {
      signal: controller.signal,
      release: () => {
        controllers.delete(controller);
        if (controllers.size === 0 && this.#running.get(orgId) === controllers) {
          this.#running.delete(orgId);
        }
      },
    };
  }

  abortAll(orgId: string): number {
    const running = this.#running.get(orgId) ?? new Set<AbortController>();
    for (const controller of running) {
      controller.abort();
    }
    this.#running.delete(orgId);
    return running.size;
  }
}

export async function sweepRetention(
  repository: OrgRepository,
  now: string,
  onlyOrgId?: string,
): Promise<DeletionRecord[]> {
  const candidates =
    onlyOrgId === undefined
      ? await repository.orgIds()
      : (await repository.hasOrg(onlyOrgId))
        ? [onlyOrgId]
        : [];
  const records: DeletionRecord[] = [];
  for (const orgId of candidates.filter((id) => id !== DEMO_ORG_ID)) {
    try {
      const { contract } = await repository.read(orgId, "contract");
      if (contract !== null && retentionElapsed(asMutable<Contract>(contract), now)) {
        records.push(await repository.offboard(orgId, now, "retention"));
      }
    } catch (error) {
      if (!(error instanceof DeletedOrgError)) {
        throw error;
      }
    }
  }
  return records;
}
