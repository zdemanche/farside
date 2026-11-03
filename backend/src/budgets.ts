import type { Finding } from "@farside/scan-contracts";
import { acceptFinding } from "./checks/define.js";
import { applyCoverageResult, recordCoverageScope, type CoverageEntry } from "./coverage.js";
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

export type BudgetSnapshot = {
  lastConfirmed: string;
  subscriptions: BudgetDefinition[];
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
    snapshot: { lastConfirmed, subscriptions },
    findings,
    coverage,
  };
}

export function applyBudgetCoverage(
  existing: CoverageEntry[],
  harvested: CoverageEntry[],
): CoverageEntry[] {
  return harvested.reduce((coverage, entry) => applyCoverageResult(coverage, entry), existing);
}

export function mergeBudgetFindings(existing: Finding[], next: Finding[]): Finding[] {
  return [...existing.filter((finding) => finding.checkId !== NO_BUDGETS), ...next];
}
