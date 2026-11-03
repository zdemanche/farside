import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  HEALTH_SCORE_FORMULA,
  validateInventory,
  type Inventory,
} from "@farside/scan-contracts";
import {
  AZURE_LAUNCH_CHECK_IDS,
  applyCoverageResult,
  blindSpots,
  coverageFromHarvest,
  coverageHealth,
  recordCoverageScope,
  toContractCoverage,
  type CoverageState,
} from "./coverage.js";
import type { CoverageCauseId } from "./causes.js";
import { analyzeAlerts, type SpendAlert } from "./alerts.js";
import {
  applyBudgetCoverage,
  defaultBudgetClient,
  harvestBudgets,
  mergeBudgetFindings,
  type BudgetClient,
} from "./budgets.js";
import {
  applyCommitmentCoverage,
  defaultCommitmentClient,
  harvestCommitments,
  mergeCommitmentFindings,
  type CommitmentClient,
} from "./commitments.js";
import {
  applyCostCoverage,
  defaultCostClient,
  harvestCost,
  type CostQueryClient,
} from "./cost.js";
import { systemClock, type Clock } from "./clock.js";
import { CardDataError, advanceContract, billingView, canScan, parseContract } from "./billing.js";
import { deletionView } from "./offboard.js";
import { demoDescriptor, isDemoOrg, seedDemoOrg } from "./demo.js";
import { exportCost, exportFilename, exportInventory, exportIssues } from "./export.js";
import { estateOverview, inventoriesFor } from "./estate.js";
import { buildHeadline } from "./headline.js";
import { costWasteView } from "./waste.js";
import { matchesCloud, parseCloudQuery, type Cloud } from "./cloud.js";
import { applyOwnerTag, browseInventories, groupInventory, noOwnerTotal } from "./inventory.js";
import { SecretLeakError, assertNoSecrets } from "./secrets.js";
import { defaultHarvester, ScanRunner, toScanView, toScanViews, type Harvester } from "./scans.js";
import { ScanScheduler } from "./scheduler.js";
import { parseSettings } from "./settings.js";
import { assertOrgAccess, sessionFromHeaders, type Session } from "./session.js";
import { MemoryStore } from "./store.js";

export const SERVICE_NAME = "farside";

type OrgParams = { orgId: string };
type ConnectionParams = { orgId: string; connectionId: string };

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
) {
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank",
    title,
    status,
    ...extra,
  });
}

function requireOrg(
  request: FastifyRequest<{ Params: OrgParams }>,
  reply: FastifyReply,
  store: MemoryStore,
  options: { allowDeleted?: boolean } = {},
): Session | null {
  const session = sessionFromHeaders(request);
  if (!session) {
    void problem(reply, 401, "Unauthorized");
    return null;
  }
  if (assertOrgAccess(session, request.params.orgId) !== "ok") {
    void problem(reply, 403, "Forbidden");
    return null;
  }
  const deletion = store.deletion(request.params.orgId);
  if (deletion && !options.allowDeleted) {
    void problem(reply, 410, "Gone", { deletedAt: deletion.deletedAt });
    return null;
  }
  if (isDemoOrg(request.params.orgId) && !deletion) {
    seedDemoOrg(store);
  }
  return session;
}

function rejectSecrets(body: unknown, reply: FastifyReply): boolean {
  try {
    assertNoSecrets(body);
    return false;
  } catch (error) {
    if (error instanceof SecretLeakError) {
      void problem(reply, 400, "Secret rejected", {
        errors: [{ path: error.message, message: "secret or token pattern" }],
      });
      return true;
    }
    throw error;
  }
}

function readCloud(
  query: unknown,
  reply: FastifyReply,
): { ok: true; cloud?: Cloud } | { ok: false } {
  const parsed = parseCloudQuery((query ?? {}) as Record<string, unknown>);
  if (parsed.error) {
    void problem(reply, 400, "Invalid cloud", {
      errors: [{ path: "cloud", message: parsed.error }],
    });
    return { ok: false };
  }
  return parsed.cloud ? { ok: true, cloud: parsed.cloud } : { ok: true };
}

function sendClean(reply: FastifyReply, status: number, body: unknown) {
  assertNoSecrets(body);
  return reply.code(status).send(body);
}

function connectionInput(body: unknown): { tenantId: string; subscriptionId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.tenantId !== "string" || record.tenantId.length === 0) {
    return null;
  }
  if (typeof record.subscriptionId !== "string" || record.subscriptionId.length === 0) {
    return null;
  }
  return { tenantId: record.tenantId, subscriptionId: record.subscriptionId };
}

export function buildApp(
  store: MemoryStore = new MemoryStore(),
  options: {
    harvester?: Harvester;
    costClient?: CostQueryClient;
    commitmentClient?: CommitmentClient;
    budgetClient?: BudgetClient;
    clock?: Clock;
    trustClientClock?: boolean;
  } = {},
) {
  const clock = options.clock ?? systemClock;
  const trustClientClock = options.trustClientClock === true;
  const clientTime = (candidate: unknown): string =>
    trustClientClock && typeof candidate === "string" ? candidate : clock();
  const runner = new ScanRunner(
    store,
    options.harvester ?? defaultHarvester(clock),
    {
      costClient: options.costClient ?? defaultCostClient(),
      commitmentClient: options.commitmentClient ?? defaultCommitmentClient(),
      budgetClient: options.budgetClient ?? defaultBudgetClient(),
    },
    clock,
  );
  const scheduler = new ScanScheduler(store, runner, clock);
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    status: "ok" as const,
    service: SERVICE_NAME,
  }));

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    return sendClean(reply, 200, demoDescriptor(request.params.orgId));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const inventories = inventoriesFor(store.snapshot(request.params.orgId), cloud.cloud);
    const inventory = cloud.cloud ? inventories[0] : store.snapshot(request.params.orgId).inventory;
    if (!inventory) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, inventory);
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory/no-owner", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const inventories = inventoriesFor(store.snapshot(request.params.orgId), cloud.cloud);
    if (inventories.length === 0) {
      return problem(reply, 404, "Not found");
    }
    const totals = inventories.reduce(
      (sum, inventory) => {
        const next = noOwnerTotal(inventory);
        return { total: sum.total + next.total, resourceUris: [...sum.resourceUris, ...next.resourceUris] };
      },
      { total: 0, resourceUris: [] as string[] },
    );
    return sendClean(reply, 200, totals);
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/connections", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    return sendClean(reply, 200, { connections: store.snapshot(request.params.orgId).connections });
  });

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/connections", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    const input = connectionInput(request.body);
    if (!input) {
      return problem(reply, 400, "Invalid connection", {
        errors: [{ path: "body", message: "tenantId and subscriptionId are required" }],
      });
    }
    const connection = store.putConnection(request.params.orgId, input);
    const asOf =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>).asOf
        : undefined;
    scheduler.applySettings(request.params.orgId, clientTime(asOf));
    if (!canScan(store.snapshot(request.params.orgId).contract)) {
      return sendClean(reply, 201, {
        ...connection,
        scan: null,
        scanStarted: false,
        attention: "scans paused",
      });
    }
    const scan = runner.start({
      orgId: request.params.orgId,
      subscriptionId: input.subscriptionId,
      actor: "user",
    });
    return sendClean(reply, 201, { ...connection, scan: scan.job, scanStarted: scan.started });
  });

  app.delete<{ Params: ConnectionParams }>(
    "/v1/orgs/:orgId/connections/:connectionId",
    async (request, reply) => {
      if (!requireOrg(request, reply, store)) {
        return reply;
      }
      if (!store.deleteConnection(request.params.orgId, request.params.connectionId)) {
        return problem(reply, 404, "Not found");
      }
      return reply.code(204).send();
    },
  );

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    const errors = validateInventory(request.body);
    if (errors.length > 0) {
      return problem(reply, 400, "Invalid inventory", { errors });
    }
    const tagged = applyOwnerTag(
      request.body as Inventory,
      store.snapshot(request.params.orgId).settings.ownerTagKey,
    );
    const stored = store.putInventory(request.params.orgId, tagged);
    const subscriptions = [...new Set(stored.resources.map((row) => row.resourceUri.split("/")[2] ?? ""))].filter(
      Boolean,
    );
    store.putCoverage(request.params.orgId, coverageFromHarvest(subscriptions, AZURE_LAUNCH_CHECK_IDS));
    return sendClean(reply, 200, stored);
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/coverage", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const org = store.snapshot(request.params.orgId);
    const coverage = org.coverage.filter((entry) => matchesCloud(entry.cloud, cloud.cloud));
    const findings = org.findings.filter((finding) => matchesCloud(finding.scope.cloud, cloud.cloud));
    const health = coverageHealth(coverage, findings);
    return sendClean(reply, 200, {
      coverage: toContractCoverage(coverage),
      entries: coverage,
      health,
      formula: HEALTH_SCORE_FORMULA,
    });
  });

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/coverage", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    const result = coverageResultInput(request.body);
    if (!result) {
      return problem(reply, 400, "Invalid coverage", {
        errors: [{ path: "body", message: "checkId, subscriptionOrProject, and state are required" }],
      });
    }
    const next = applyCoverageResult(store.snapshot(request.params.orgId).coverage, result);
    store.putCoverage(request.params.orgId, next);
    return sendClean(reply, 200, recordCoverageScope(result));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/blind-spots", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const org = store.snapshot(request.params.orgId);
    const coverage = org.coverage.filter((entry) => matchesCloud(entry.cloud, cloud.cloud));
    const findings = org.findings.filter((finding) => matchesCloud(finding.scope.cloud, cloud.cloud));
    const spots = blindSpots(coverage);
    const health = coverageHealth(coverage, findings);
    return sendClean(reply, 200, { spots, health, formula: HEALTH_SCORE_FORMULA });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/scans", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const scans = toScanViews(store.snapshot(request.params.orgId).scans).filter(
      (scan) => cloud.cloud == null || scan.cloud === cloud.cloud,
    );
    return sendClean(reply, 200, { scans });
  });

  app.get<{ Params: { orgId: string; scanId: string } }>(
    "/v1/orgs/:orgId/scans/:scanId",
    async (request, reply) => {
      if (!requireOrg(request, reply, store)) {
        return reply;
      }
      const view = toScanViews(store.snapshot(request.params.orgId).scans).find(
        (scan) => scan.id === request.params.scanId,
      );
      if (!view) {
        return problem(reply, 404, "Not found");
      }
      return sendClean(reply, 200, view);
    },
  );

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/scans", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const body = request.body as Record<string, unknown> | null;
    const subscriptionId = body && typeof body.subscriptionId === "string" ? body.subscriptionId : "";
    const actor = body && body.actor === "system" ? "system" : "user";
    if (!subscriptionId) {
      return problem(reply, 400, "Invalid scan", {
        errors: [{ path: "subscriptionId", message: "required string" }],
      });
    }
    if (isDemoOrg(request.params.orgId)) {
      const job = store.snapshot(request.params.orgId).scans[0];
      if (!job) {
        return problem(reply, 404, "Not found");
      }
      return sendClean(reply, 200, { scan: toScanView(job, true), scanStarted: false });
    }
    if (!canScan(store.snapshot(request.params.orgId).contract)) {
      return problem(reply, 409, "Scans paused", { attention: "scans paused" });
    }
    const scan = runner.start({ orgId: request.params.orgId, subscriptionId, actor });
    return sendClean(reply, scan.started ? 202 : 200, {
      scan: toScanView(scan.job, false),
      scanStarted: scan.started,
    });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/findings", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const findings = store
      .snapshot(request.params.orgId)
      .findings.filter((finding) => matchesCloud(finding.scope.cloud, cloud.cloud));
    return sendClean(reply, 200, { findings });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/issues", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const issues = store
      .snapshot(request.params.orgId)
      .issues.filter((issue) => matchesCloud(issue.cloud, cloud.cloud));
    return sendClean(reply, 200, { issues });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/export/issues", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const query = request.query as Record<string, unknown>;
    const exportedAt = clientTime(query.asOf);
    const issues = store
      .snapshot(request.params.orgId)
      .issues.filter((issue) => matchesCloud(issue.cloud, cloud.cloud));
    void reply.header("content-disposition", `attachment; filename="${exportFilename("issues")}"`);
    return sendClean(reply, 200, exportIssues(request.params.orgId, issues, exportedAt));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/export/inventory", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const query = request.query as Record<string, unknown>;
    const exportedAt = clientTime(query.asOf);
    const inventories = inventoriesFor(store.snapshot(request.params.orgId), cloud.cloud);
    const inventory = cloud.cloud
      ? inventories[0] ?? null
      : store.snapshot(request.params.orgId).inventory;
    void reply.header("content-disposition", `attachment; filename="${exportFilename("inventory")}"`);
    return sendClean(reply, 200, exportInventory(request.params.orgId, inventory ?? null, exportedAt));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/export/cost", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const query = request.query as Record<string, unknown>;
    const exportedAt = clientTime(query.asOf);
    void reply.header("content-disposition", `attachment; filename="${exportFilename("cost")}"`);
    return sendClean(reply, 200, exportCost(request.params.orgId, store.snapshot(request.params.orgId).cost, exportedAt));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/cost-waste", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const org = store.snapshot(request.params.orgId);
    return sendClean(
      reply,
      200,
      costWasteView({
        cost: org.cost,
        alerts: org.alerts,
        commitments: org.commitments,
        findings: org.findings.filter((finding) => matchesCloud(finding.scope.cloud, cloud.cloud)),
        coverage: org.coverage.filter((entry) => matchesCloud(entry.cloud, cloud.cloud)),
      }),
    );
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/headline", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const org = store.snapshot(request.params.orgId);
    return sendClean(
      reply,
      200,
      buildHeadline({
        cost: org.cost,
        findings: org.findings,
        coverage: org.coverage,
        ...(cloud.cloud ? { cloud: cloud.cloud } : {}),
      }),
    );
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/cost", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cost = store.snapshot(request.params.orgId).cost;
    if (!cost) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, cost);
  });

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/cost", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    const body = request.body as Record<string, unknown> | null;
    const subscriptionId = body && typeof body.subscriptionId === "string" ? body.subscriptionId : "";
    if (!subscriptionId) {
      return problem(reply, 400, "Invalid cost harvest", {
        errors: [{ path: "subscriptionId", message: "required string" }],
      });
    }
    const billingScope =
      body && typeof body.billingScope === "string" && body.billingScope.length > 0
        ? body.billingScope
        : `/subscriptions/${subscriptionId}`;
    const agreementType =
      body && typeof body.agreementType === "string" && body.agreementType.length > 0
        ? body.agreementType
        : "payg";
    if (isDemoOrg(request.params.orgId)) {
      return sendClean(reply, 200, {
        harvested: true,
        cost: store.snapshot(request.params.orgId).cost,
      });
    }
    const harvested = await harvestCost({
      client: options.costClient ?? defaultCostClient(),
      subscriptionId,
      billingScope,
      agreementType,
      asOf: clock(),
    });
    store.putCoverage(
      request.params.orgId,
      applyCostCoverage(store.snapshot(request.params.orgId).coverage, harvested.coverage),
    );
    if (!harvested.ok) {
      store.putCost(request.params.orgId, null);
      return sendClean(reply, 200, {
        harvested: false,
        reason: harvested.reason,
        closer: harvested.coverage[0]?.closer,
      });
    }
    store.putCost(request.params.orgId, harvested.snapshot);
    return sendClean(reply, 200, { harvested: true, cost: harvested.snapshot });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/commitments", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const commitments = store.snapshot(request.params.orgId).commitments;
    if (!commitments) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, commitments);
  });

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/commitments", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    const body = request.body as Record<string, unknown> | null;
    const subscriptionId = body && typeof body.subscriptionId === "string" ? body.subscriptionId : "";
    if (!subscriptionId) {
      return problem(reply, 400, "Invalid commitment harvest", {
        errors: [{ path: "subscriptionId", message: "required string" }],
      });
    }
    const billingScope =
      body && typeof body.billingScope === "string" && body.billingScope.length > 0
        ? body.billingScope
        : `/subscriptions/${subscriptionId}`;
    if (isDemoOrg(request.params.orgId)) {
      const org = store.snapshot(request.params.orgId);
      return sendClean(reply, 200, {
        harvested: true,
        commitments: org.commitments,
        findings: org.findings,
      });
    }
    const harvested = await harvestCommitments({
      client: options.commitmentClient ?? defaultCommitmentClient(),
      subscriptionId,
      billingScope,
    });
    store.putCoverage(
      request.params.orgId,
      applyCommitmentCoverage(store.snapshot(request.params.orgId).coverage, harvested.coverage),
    );
    if (!harvested.ok) {
      store.putCommitments(request.params.orgId, null);
      return sendClean(reply, 200, {
        harvested: false,
        reason: harvested.reason,
        closer: harvested.coverage[0]?.closer,
      });
    }
    store.putCommitments(request.params.orgId, harvested.snapshot);
    store.putFindings(
      request.params.orgId,
      mergeCommitmentFindings(store.snapshot(request.params.orgId).findings, harvested.findings),
    );
    return sendClean(reply, 200, {
      harvested: true,
      commitments: harvested.snapshot,
      findings: harvested.findings,
    });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/budgets", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const budgets = store.snapshot(request.params.orgId).budgets;
    if (!budgets) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, budgets);
  });

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/budgets", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    if (isDemoOrg(request.params.orgId)) {
      const org = store.snapshot(request.params.orgId);
      return sendClean(reply, 200, {
        harvested: true,
        budgets: org.budgets,
        findings: org.findings,
      });
    }
    const harvested = await harvestBudgets({
      client: options.budgetClient ?? defaultBudgetClient(),
      lastConfirmed: clock(),
    });
    store.putCoverage(
      request.params.orgId,
      applyBudgetCoverage(store.snapshot(request.params.orgId).coverage, harvested.coverage),
    );
    store.putBudgets(request.params.orgId, harvested.snapshot);
    store.putFindings(
      request.params.orgId,
      mergeBudgetFindings(store.snapshot(request.params.orgId).findings, harvested.findings),
    );
    return sendClean(reply, 200, {
      harvested: true,
      budgets: harvested.snapshot,
      findings: harvested.findings,
    });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/alerts", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const alerts = store.snapshot(request.params.orgId).alerts;
    if (!alerts) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, alerts);
  });

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/alerts", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    if (isDemoOrg(request.params.orgId)) {
      return sendClean(reply, 200, store.snapshot(request.params.orgId).alerts);
    }
    const body = (request.body as Record<string, unknown> | null) ?? {};
    const recipients = Array.isArray(body.recipients)
      ? body.recipients.filter((item): item is string => typeof item === "string")
      : [];
    const previous = Array.isArray(body.previous) ? (body.previous as SpendAlert[]) : [];
    const analysis = analyzeAlerts({
      recipients,
      previous,
      ...(typeof body.asOf === "string" ? { asOf: body.asOf } : {}),
    });
    store.putAlerts(request.params.orgId, analysis);
    return sendClean(reply, 200, analysis);
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/estate", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    return sendClean(reply, 200, estateOverview(store.snapshot(request.params.orgId), cloud.cloud));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/settings", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    return sendClean(reply, 200, store.snapshot(request.params.orgId).settings);
  });

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/settings", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    const parsed = parseSettings(request.body);
    if (!parsed) {
      return problem(reply, 400, "Invalid settings", {
        errors: [
          {
            path: "body",
            message: "ownerTagKey, productionTagKey, and productionTagValue are required",
          },
        ],
      });
    }
    const body = (request.body as Record<string, unknown> | null) ?? {};
    const saved = store.putSettings(request.params.orgId, {
      ...parsed,
      updatedAt: clock(),
    });
    const schedule = scheduler.applySettings(request.params.orgId, clientTime(body.asOf));
    return sendClean(reply, 200, { ...saved, nextRunAt: schedule.nextRunAt });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/schedule", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const org = store.snapshot(request.params.orgId);
    const attention = org.connections.length === 0 || org.connections.every((item) => !item.healthy)
      ? "connection needs attention"
      : null;
    return sendClean(reply, 200, {
      ...org.schedule,
      enabled: org.settings.scanScheduleEnabled,
      intervalHours: org.settings.scanIntervalHours,
      retryLimit: org.settings.scanRetryLimit,
      attention,
    });
  });

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/schedule/tick", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const body = (request.body as Record<string, unknown> | null) ?? {};
    const now = clientTime(body.now);
    if (!canScan(store.snapshot(request.params.orgId).contract)) {
      return sendClean(reply, 200, {
        action: "blocked",
        attention: "scans paused",
        record: null,
        scan: null,
        scanStarted: false,
        schedule: store.snapshot(request.params.orgId).schedule,
      });
    }
    const tick = scheduler.tick(request.params.orgId, now);
    return sendClean(reply, 200, {
      action: tick.action,
      attention: tick.attention,
      record: tick.record,
      scan: tick.scan ? toScanView(tick.scan, false) : null,
      scanStarted: tick.scanStarted,
      schedule: tick.schedule,
    });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/contract", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const contract = store.snapshot(request.params.orgId).contract;
    if (!contract) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, billingView(contract));
  });

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/contract", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    if (rejectSecrets(request.body, reply)) {
      return reply;
    }
    const body = (request.body as Record<string, unknown> | null) ?? {};
    const now = clientTime(body.asOf);
    try {
      const parsed = parseContract(request.body, now);
      if (!parsed) {
        return problem(reply, 400, "Invalid contract", {
          errors: [{ path: "body", message: "plan and startDate are required" }],
        });
      }
      store.putContract(request.params.orgId, parsed);
      return sendClean(reply, 200, billingView(parsed));
    } catch (error) {
      if (error instanceof CardDataError) {
        return problem(reply, 400, "Card data rejected");
      }
      throw error;
    }
  });

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/contract/advance", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const current = store.snapshot(request.params.orgId).contract;
    if (!current) {
      return problem(reply, 404, "Not found");
    }
    const body = (request.body as Record<string, unknown> | null) ?? {};
    const now = trustClientClock
      ? typeof body.now === "string"
        ? body.now
        : current.stateChangedAt
      : clock();
    const event =
      body.event === "failed_payment" || body.event === "paid" || body.event === "ended"
        ? body.event
        : undefined;
    const next = advanceContract(current, event ? { now, event } : { now });
    store.putContract(request.params.orgId, next);
    return sendClean(reply, 200, billingView(next));
  });

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/offboard", async (request, reply) => {
    if (!requireOrg(request, reply, store, { allowDeleted: true })) {
      return reply;
    }
    const existing = store.deletion(request.params.orgId);
    if (existing) {
      return sendClean(reply, 200, deletionView(existing));
    }
    const body = (request.body as Record<string, unknown> | null) ?? {};
    if (body.confirm !== true || body.exportOffered !== true) {
      return problem(reply, 400, "Offboard not confirmed", {
        errors: [
          {
            path: "body",
            message: "confirm and exportOffered must be true",
          },
        ],
      });
    }
    const now = clientTime(body.now);
    const record = store.offboard(request.params.orgId, now);
    return sendClean(reply, 200, deletionView(record));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/deletion", async (request, reply) => {
    if (!requireOrg(request, reply, store, { allowDeleted: true })) {
      return reply;
    }
    const record = store.deletion(request.params.orgId);
    if (!record) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, deletionView(record));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory/browse", async (request, reply) => {
    if (!requireOrg(request, reply, store)) {
      return reply;
    }
    const cloud = readCloud(request.query, reply);
    if (!cloud.ok) {
      return reply;
    }
    const inventories = inventoriesFor(store.snapshot(request.params.orgId), cloud.cloud);
    if (inventories.length === 0) {
      return problem(reply, 404, "Not found");
    }
    const query = request.query as Record<string, unknown>;
    const filters: {
      owner?: string;
      service?: string;
      subscription?: string;
      region?: string;
      cloud?: Cloud;
    } = {};
    if (typeof query.owner === "string") {
      filters.owner = query.owner;
    }
    if (typeof query.service === "string") {
      filters.service = query.service;
    }
    if (typeof query.subscription === "string") {
      filters.subscription = query.subscription;
    }
    if (typeof query.region === "string") {
      filters.region = query.region;
    }
    if (cloud.cloud) {
      filters.cloud = cloud.cloud;
    }
    const resources = browseInventories(inventories, filters);
    return sendClean(reply, 200, {
      resources,
      total: resources.length,
      grouped: groupInventory(resources),
    });
  });

  return app;
}

function coverageResultInput(body: unknown): {
  subscriptionOrProject: string;
  checkId: string;
  state: CoverageState;
  causeId?: CoverageCauseId;
  closer?: string;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.checkId !== "string" || record.checkId.length === 0) {
    return null;
  }
  if (typeof record.subscriptionOrProject !== "string" || record.subscriptionOrProject.length === 0) {
    return null;
  }
  if (record.state !== "assessed" && record.state !== "unassessed" && record.state !== "undetermined") {
    return null;
  }
  const result: {
    subscriptionOrProject: string;
    checkId: string;
    state: CoverageState;
    causeId?: CoverageCauseId;
    closer?: string;
  } = {
    subscriptionOrProject: record.subscriptionOrProject,
    checkId: record.checkId,
    state: record.state,
  };
  if (typeof record.causeId === "string") {
    result.causeId = record.causeId as CoverageCauseId;
  }
  if (typeof record.closer === "string") {
    result.closer = record.closer;
  }
  return result;
}
