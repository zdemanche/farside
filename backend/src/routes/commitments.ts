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
      const commitments = ctx.store.view(request.params.orgId).commitments;
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
        demo: (store, orgId) => {
          const org = store.view(orgId);
          return {
            status: 200,
            body: { harvested: true, commitments: org.commitments, findings: org.findings },
          };
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const connected = requireConnected(
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
      ctx.store.putCoverage(
        orgId,
        applyCommitmentCoverage(ctx.store.view(orgId).coverage, commitmentHarvest.coverage),
      );
      if (!commitmentHarvest.ok) {
        ctx.store.putCommitments(orgId, null, connected);
        return sendClean(reply, 200, {
          harvested: false,
          reason: commitmentHarvest.reason,
          closer: commitmentHarvest.coverage[0]?.closer,
        });
      }
      ctx.store.putCommitments(orgId, commitmentHarvest.snapshot, connected);
      ctx.store.putFindings(
        orgId,
        mergeCommitmentFindings(
          ctx.store.view(orgId).findings,
          commitmentHarvest.findings,
          connected,
        ),
      );
      ctx.store.putIssues(
        orgId,
        applyScanToIssues({
          issues: ctx.store.view(orgId).issues,
          findings: commitmentHarvest.findings,
          coverage: ctx.store.view(orgId).coverage,
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
      const budgets = ctx.store.view(request.params.orgId).budgets;
      return budgets ? sendClean(reply, 200, budgets) : problem(reply, 404, "Not found");
    },
  );

  app.post<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/budgets",
    {
      schema: { params: orgParams },
      config: {
        demo: (store, orgId) => {
          const org = store.view(orgId);
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
      ctx.store.putCoverage(
        orgId,
        applyBudgetCoverage(ctx.store.view(orgId).coverage, budgetHarvest.coverage),
      );
      ctx.store.putBudgets(orgId, budgetHarvest.snapshot);
      ctx.store.putFindings(
        orgId,
        mergeBudgetFindings(ctx.store.view(orgId).findings, budgetHarvest.findings),
      );
      ctx.store.putIssues(
        orgId,
        applyScanToIssues({
          issues: ctx.store.view(orgId).issues,
          findings: budgetHarvest.findings,
          coverage: ctx.store.view(orgId).coverage,
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
