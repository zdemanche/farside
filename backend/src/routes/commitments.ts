import {
  applyBudgetCoverage,
  harvestBudgets,
  mergeBudgetFindings,
  NO_BUDGETS,
  unconfiguredBudgetClient,
} from "../budgets.js";
import {
  applyCommitmentCoverage,
  harvestCommitments,
  mergeCommitmentFindings,
  RESERVATION_USE,
  SAVINGS_PLAN_USE,
  unconfiguredCommitmentClient,
} from "../commitments.js";
import { guardProviderClient } from "../demo.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { problem, requireConnected, sendClean, withProvider } from "../http/responses.js";
import { commitmentHarvestBody, orgParams } from "../http/schemas.js";
import { applyScanToIssues } from "../issues.js";

export const commitmentRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/commitments",
    { schema: { params: orgParams } },
    async (request, reply) => {
      const { commitments } = await ctx.store.read(request.params.orgId, "commitments");
      return commitments ? sendClean(reply, 200, commitments) : problem(reply, 404, "Not found");
    },
  );

  app.post<{ Params: OrgParams; Body: { subscriptionId: string } }>(
    "/v1/orgs/:orgId/commitments",
    {
      schema: { params: orgParams, body: commitmentHarvestBody },
      config: {
        rejectSecrets: true,
        invalidTitle: "Invalid commitment harvest",
        demo: async (store, orgId) => {
          const org = await store.read(orgId, "commitments", "findings");
          return {
            status: 200,
            body: { harvested: true, commitments: org.commitments, findings: org.findings },
          };
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const connected = await requireConnected(
        ctx,
        request,
        reply,
        request.body.subscriptionId,
        "Invalid commitment harvest",
      );
      if (!connected) {
        return reply;
      }
      const harvested = await withProvider(reply, () =>
        harvestCommitments({
          client: guardProviderClient(
            orgId,
            ctx.clients.commitment ?? unconfiguredCommitmentClient(),
          ),
          subscriptionId: connected,
          billingScope: `/subscriptions/${connected}`,
        }),
      );
      if (!harvested.ok) {
        return reply;
      }
      const commitmentHarvest = harvested.value;
      await ctx.store.putCoverage(
        orgId,
        applyCommitmentCoverage(
          (await ctx.store.read(orgId, "coverage")).coverage,
          commitmentHarvest.coverage,
        ),
      );
      if (!commitmentHarvest.ok) {
        await ctx.store.putCommitments(orgId, null, connected);
        return sendClean(reply, 200, {
          harvested: false,
          reason: commitmentHarvest.reason,
          closer: commitmentHarvest.coverage[0]?.closer,
        });
      }
      await ctx.store.putCommitments(orgId, commitmentHarvest.snapshot, connected);
      await ctx.store.putFindings(
        orgId,
        mergeCommitmentFindings(
          (await ctx.store.read(orgId, "findings")).findings,
          commitmentHarvest.findings,
          connected,
        ),
      );
      const stored = await ctx.store.read(orgId, "issues", "coverage");
      await ctx.store.putIssues(
        orgId,
        applyScanToIssues({
          issues: stored.issues,
          findings: commitmentHarvest.findings,
          coverage: stored.coverage,
          scanId: "harvest-commitments",
          observedAt: commitmentHarvest.snapshot.periodEnd,
          checkIds: [RESERVATION_USE, SAVINGS_PLAN_USE],
        }),
      );
      return sendClean(reply, 200, {
        harvested: true,
        commitments: commitmentHarvest.snapshot,
        findings: commitmentHarvest.findings,
      });
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/budgets",
    { schema: { params: orgParams } },
    async (request, reply) => {
      const { budgets } = await ctx.store.read(request.params.orgId, "budgets");
      return budgets ? sendClean(reply, 200, budgets) : problem(reply, 404, "Not found");
    },
  );

  app.post<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/budgets",
    {
      schema: { params: orgParams },
      config: {
        demo: async (store, orgId) => {
          const org = await store.read(orgId, "budgets", "findings");
          return {
            status: 200,
            body: { harvested: true, budgets: org.budgets, findings: org.findings },
          };
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const harvested = await withProvider(reply, () =>
        harvestBudgets({
          client: guardProviderClient(orgId, ctx.clients.budget ?? unconfiguredBudgetClient()),
          lastConfirmed: ctx.clock(),
        }),
      );
      if (!harvested.ok) {
        return reply;
      }
      const budgetHarvest = harvested.value;
      await ctx.store.putCoverage(
        orgId,
        applyBudgetCoverage((await ctx.store.read(orgId, "coverage")).coverage, budgetHarvest.coverage),
      );
      await ctx.store.putBudgets(orgId, budgetHarvest.snapshot);
      await ctx.store.putFindings(
        orgId,
        mergeBudgetFindings((await ctx.store.read(orgId, "findings")).findings, budgetHarvest.findings),
      );
      const stored = await ctx.store.read(orgId, "issues", "coverage");
      await ctx.store.putIssues(
        orgId,
        applyScanToIssues({
          issues: stored.issues,
          findings: budgetHarvest.findings,
          coverage: stored.coverage,
          scanId: "harvest-budgets",
          observedAt: budgetHarvest.snapshot.lastConfirmed,
          checkIds: [NO_BUDGETS],
        }),
      );
      return sendClean(reply, 200, {
        harvested: true,
        budgets: budgetHarvest.snapshot,
        findings: budgetHarvest.findings,
      });
    },
  );
};
