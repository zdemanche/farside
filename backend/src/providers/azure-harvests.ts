import { abortable } from "../abortable.js";
import { applyBudgetCoverage, harvestBudgets, mergeBudgetFindings } from "../budgets.js";
import { applyCommitmentCoverage, harvestCommitments, mergeCommitmentFindings } from "../commitments.js";
import { applyCostCoverage, harvestCost } from "../cost.js";
import { applyCoverageResult, recordCoverageScope, type CoverageEntry } from "../coverage.js";
import { AZURE_LAUNCH_CHECK_IDS } from "./launch-ids.js";
import type { PostHarvest, PostHarvestContext, ScanOutputs } from "./types.js";

type AzureHarvests = {
  cost?: Awaited<ReturnType<typeof harvestCost>>;
  commitments?: Awaited<ReturnType<typeof harvestCommitments>>;
  budgets?: Awaited<ReturnType<typeof harvestBudgets>>;
};

function fillUnrunLaunchCoverage(coverage: CoverageEntry[], subscriptionId: string): CoverageEntry[] {
  let next = coverage;
  for (const checkId of AZURE_LAUNCH_CHECK_IDS) {
    if (next.some((entry) => entry.checkId === checkId && entry.subscriptionOrProject === subscriptionId)) {
      continue;
    }
    next = applyCoverageResult(
      next,
      recordCoverageScope({
        subscriptionOrProject: subscriptionId,
        checkId,
        state: "unassessed",
        causeId: "not_run",
      }),
    );
  }
  return next;
}

async function applyAzureHarvests(
  { orgId, subscriptionId, store }: PostHarvestContext,
  collected: AzureHarvests,
  outputs: ScanOutputs,
): Promise<ScanOutputs> {
  let { findings, coverage } = outputs;
  if (collected.cost) {
    coverage = applyCostCoverage(coverage, collected.cost.coverage);
    await store.putCost(orgId, collected.cost.ok ? collected.cost.snapshot : null, subscriptionId);
  }
  if (collected.commitments) {
    coverage = applyCommitmentCoverage(coverage, collected.commitments.coverage);
    if (collected.commitments.ok) {
      await store.putCommitments(orgId, collected.commitments.snapshot, subscriptionId);
      findings = mergeCommitmentFindings(findings, collected.commitments.findings, subscriptionId);
    } else {
      await store.putCommitments(orgId, null, subscriptionId);
    }
  }
  if (collected.budgets) {
    coverage = applyBudgetCoverage(coverage, collected.budgets.coverage);
    await store.putBudgets(orgId, collected.budgets.snapshot);
    findings = mergeBudgetFindings(findings, collected.budgets.findings);
  }
  return { findings, coverage: fillUnrunLaunchCoverage(coverage, subscriptionId) };
}

export async function collectAzureHarvests(context: PostHarvestContext): Promise<PostHarvest | null> {
  const { subscriptionId, signal, remainingMs, clock, clients } = context;
  const billingScope = `/subscriptions/${subscriptionId}`;
  const collected: AzureHarvests = {};
  if (clients.costClient) {
    collected.cost = await abortable(
      signal,
      harvestCost({
        client: clients.costClient,
        subscriptionId,
        billingScope,
        agreementType: "payg",
        asOf: clock(),
      }),
      remainingMs(),
    );
    if (signal.aborted) {
      return null;
    }
  }
  if (clients.commitmentClient) {
    collected.commitments = await abortable(
      signal,
      harvestCommitments({ client: clients.commitmentClient, subscriptionId, billingScope }),
      remainingMs(),
    );
    if (signal.aborted) {
      return null;
    }
  }
  if (clients.budgetClient) {
    collected.budgets = await abortable(
      signal,
      harvestBudgets({ client: clients.budgetClient, lastConfirmed: clock() }),
      remainingMs(),
    );
    if (signal.aborted) {
      return null;
    }
  }
  return { apply: (outputs) => applyAzureHarvests(context, collected, outputs) };
}
