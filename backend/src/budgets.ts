import type { Finding } from "@farside/scan-contracts";
import { acceptFinding } from "./checks/define.js";
import { applyCoverageResults, recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { rejectUnconfigured } from "./providers/unconfigured.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };

type BudgetManifest = {
  subscriptions: Array<{
    id: string;
    budget: { present: boolean; name?: string };
  }>;
};

export const NO_BUDGETS = "azure-cost-subscriptions-without-budgets";
export const BUDGET_CLOSER =
  "Cost Management Reader and a successful budgets list on that subscription";

export type BudgetDefinition = {
  subscriptionId: string;
  budgetCount: number;
  budgetNames: string[];
  readable: boolean;
};

export const BUDGET_HARVEST_UNVERIFIED = {
  harvestStatus: "unverified",
  liveRunAt: null,
  harvestStatusReason:
    "Budget definitions are read from the ground-truth fixture. A live Cost Management budgets list stays leftover.",
} as const;

export type BudgetSnapshot = {
  lastConfirmed: string;
  subscriptions: BudgetDefinition[];
  harvestStatus?: "unverified";
  liveRunAt?: string | null;
  harvestStatusReason?: string;
};

export type BudgetHarvestResult = {
  snapshot: BudgetSnapshot;
  findings: Finding[];
  coverage: CoverageEntry[];
};

export type BudgetClient = {
  list: () => Promise<BudgetDefinition[]>;
};

const MANIFEST = docAzureGroundTruth as BudgetManifest;

export function budgetsFromManifest(
  manifest: BudgetManifest = MANIFEST,
  unread: string[] = [],
): BudgetDefinition[] {
  return manifest.subscriptions.map((subscription) => {
    if (unread.includes(subscription.id)) {
      return {
        subscriptionId: subscription.id,
        budgetCount: 0,
        budgetNames: [],
        readable: false,
      };
    }
    const names = subscription.budget.present && subscription.budget.name ? [subscription.budget.name] : [];
    return {
      subscriptionId: subscription.id,
      budgetCount: names.length,
      budgetNames: names,
      readable: true,
    };
  });
}

export function fixtureBudgetClient(
  definitions: BudgetDefinition[] = budgetsFromManifest(),
): BudgetClient {
  return {
    async list() {
      return definitions;
    },
  };
}

export function unreadBudgetClient(subscriptionId: string): BudgetClient {
  return fixtureBudgetClient(budgetsFromManifest(MANIFEST, [subscriptionId]));
}

export function defaultBudgetClient(): BudgetClient {
  return fixtureBudgetClient();
}

export function unconfiguredBudgetClient(): BudgetClient {
  return {
    async list() {
      rejectUnconfigured();
    },
  };
}

export function checkNoBudgets(
  definitions: BudgetDefinition[],
  lastConfirmed: string,
): Finding[] {
  return definitions.map((row) => {
    const scope = {
      id: `${row.subscriptionId}:${NO_BUDGETS}`,
      cloud: "azure" as const,
      subscriptionOrProject: row.subscriptionId,
    };
    if (!row.readable) {
      return acceptFinding({
        checkId: NO_BUDGETS,
        result: "undetermined",
        closer: BUDGET_CLOSER,
        evidence: {
          fields: {
            subscriptionId: row.subscriptionId,
            budgetCount: null,
            budgetNames: null,
            lastConfirmed,
          },
        },
        scope,
      });
    }
    return acceptFinding({
      checkId: NO_BUDGETS,
      result: row.budgetCount === 0 ? "fail" : "pass",
      evidence: {
        fields: {
          subscriptionId: row.subscriptionId,
          budgetCount: row.budgetCount,
          budgetNames: row.budgetNames.join(","),
          lastConfirmed,
        },
      },
      scope,
    });
  });
}

export async function harvestBudgets(input: {
  client: BudgetClient;
  lastConfirmed?: string;
}): Promise<BudgetHarvestResult> {
  const lastConfirmed = input.lastConfirmed ?? "1970-01-01T00:00:00.000Z";
  const subscriptions = await input.client.list();
  const findings = checkNoBudgets(subscriptions, lastConfirmed);
  const coverage = subscriptions.map((row) =>
    recordCoverageScope({
      subscriptionOrProject: row.subscriptionId,
      checkId: NO_BUDGETS,
      state: row.readable ? "assessed" : "undetermined",
      ...(row.readable ? {} : { closer: BUDGET_CLOSER }),
    }),
  );
  return {
    snapshot: {
      lastConfirmed,
      subscriptions,
      harvestStatus: BUDGET_HARVEST_UNVERIFIED.harvestStatus,
      liveRunAt: BUDGET_HARVEST_UNVERIFIED.liveRunAt,
      harvestStatusReason: BUDGET_HARVEST_UNVERIFIED.harvestStatusReason,
    },
    findings,
    coverage,
  };
}

export function applyBudgetCoverage(
  existing: readonly CoverageEntry[],
  harvested: readonly CoverageEntry[],
): CoverageEntry[] {
  return applyCoverageResults(existing, harvested);
}

/**
 * Without `subscriptionIds` every budget finding is replaced (an org-wide list). With them,
 * only those subscriptions are, so a one-subscription scan keeps the others' findings.
 */
export function mergeBudgetFindings(
  existing: readonly Finding[],
  next: readonly Finding[],
  subscriptionIds?: readonly string[],
): Finding[] {
  const scope = subscriptionIds ? new Set(subscriptionIds.map((id) => id.toLowerCase())) : null;
  return [
    ...existing.filter(
      (finding) =>
        finding.checkId !== NO_BUDGETS ||
        (scope !== null && !scope.has(finding.scope.subscriptionOrProject.toLowerCase())),
    ),
    ...next,
  ];
}

/** Keeps rows for subscriptions the new snapshot did not list. */
export function mergeBudgetSnapshot(existing: BudgetSnapshot | null, next: BudgetSnapshot): BudgetSnapshot {
  if (!existing) {
    return next;
  }
  const listed = new Set(next.subscriptions.map((row) => row.subscriptionId.toLowerCase()));
  return {
    ...next,
    subscriptions: [
      ...existing.subscriptions.filter((row) => !listed.has(row.subscriptionId.toLowerCase())),
      ...next.subscriptions,
    ],
  };
}
