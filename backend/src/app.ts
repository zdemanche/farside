import { randomUUID } from "node:crypto";
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  HEALTH_SCORE_FORMULA,
  validateInventory,
  type Inventory,
} from "@farside/scan-contracts";
import {
  applyCoverageResult,
  blindSpots,
  coverageFromHarvest,
  launchCheckIds,
  coverageHealth,
  recordCoverageScope,
  toContractCoverage,
  type CoverageState,
} from "./coverage.js";
import type { CoverageCauseId } from "./causes.js";
import { analyzeAlerts, type DailyCost, type SpendAlert } from "./alerts.js";
import {
  applyBudgetCoverage,
  harvestBudgets,
  mergeBudgetFindings,
  NO_BUDGETS,
  unconfiguredBudgetClient,
  type BudgetClient,
} from "./budgets.js";
import {
  applyCommitmentCoverage,
  harvestCommitments,
  mergeCommitmentFindings,
  RESERVATION_USE,
  SAVINGS_PLAN_USE,
  unconfiguredCommitmentClient,
  type CommitmentClient,
} from "./commitments.js";
import { applyScanToIssues } from "./issues.js";
import {
  applyCostCoverage,
  harvestCost,
  unconfiguredCostClient,
  type CostQueryClient,
} from "./cost.js";
import { ProviderNotConfiguredError } from "./providers.js";
import type { Clock } from "./clock.js";
import {
  CardDataError,
  advanceContract,
  billingView,
  canScan,
  isReadOnly,
  parseContract,
} from "./billing.js";
import { deletionView } from "./offboard.js";
import { demoDescriptor, guardHarvester, guardProviderClient, isDemoOrg, seedDemoOrg } from "./demo.js";
import { exportCost, exportFilename, exportInventory, exportIssues } from "./export.js";
import { estateOverview, inventoriesFor } from "./estate.js";
import { buildHeadline } from "./headline.js";
import { costWasteView } from "./waste.js";
import { matchesCloud, parseCloudQuery, type Cloud } from "./cloud.js";
import { applyOwnerTag, browseInventories, groupInventory, noOwnerTotal } from "./inventory.js";
import { scopeOf } from "./scope.js";
import {
  audit,
  auditRetention,
  emitDecision,
  pinoOptions,
  type LoggerOptions,
} from "./observability.js";
import { SecretLeakError, assertNoSecrets } from "./secrets.js";
import { ScanRunner, toScanView, toScanViews, unconfiguredHarvester, type Harvester } from "./scans.js";
import { ScanScheduler } from "./scheduler.js";
import { parseSettings } from "./settings.js";
import { assertOrgAccess, isOperator, sessionFromHeaders, type Session } from "./session.js";
import { MemoryStore } from "./store.js";

export const SERVICE_NAME = "farside";

type OrgParams = { orgId: string };
type ConnectionParams = { orgId: string; connectionId: string };

const ORG_ROUTE_PREFIX = "/v1/orgs/:orgId";
const NON_MUTATING_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEMO_CANNED_POSTS = new Set([
  "POST /scans",
  "POST /cost",
  "POST /commitments",
  "POST /budgets",
  "POST /alerts",
]);
const AUDITED_STATUSES = new Set([401, 403, 409]);
const READ_ONLY_EXEMPT = new Set(["POST /offboard", "POST /schedule/tick"]);

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
) {
  if (AUDITED_STATUSES.has(status)) {
    audit(reply.request.log, `http.${status}`, { title });
  }
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

async function withProvider<T>(
  reply: FastifyReply,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      void problem(reply, 503, error.message);
      return { ok: false };
    }
    throw error;
  }
}

const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

function connectedSubscription(store: MemoryStore, orgId: string, subscriptionId: string): string | null {
  const wanted = subscriptionId.toLowerCase();
  const match = store
    .snapshot(orgId)
    .connections.find((connection) => connection.subscriptionId.toLowerCase() === wanted);
  return match?.subscriptionId ?? null;
}

function connectionInput(body: unknown): { tenantId: string; subscriptionId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.tenantId !== "string" || record.tenantId.length === 0) {
    return null;
  }
  if (typeof record.subscriptionId !== "string" || !SUBSCRIPTION_ID_PATTERN.test(record.subscriptionId)) {
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
    operatorToken?: string | undefined;
    logger?: LoggerOptions;
    scanTimeoutMs?: number;
  } = {},
) {
  const clock = options.clock ?? store.clock;
  const trustClientClock = options.trustClientClock === true;
  const clientTime = (candidate: unknown): string =>
    trustClientClock && typeof candidate === "string" ? candidate : clock();
  const app = Fastify({
    logger: pinoOptions(options.logger),
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
  });
  const runner = new ScanRunner(
    store,
    guardHarvester(options.harvester ?? unconfiguredHarvester()),
    {
      ...(options.costClient ? { costClient: options.costClient } : {}),
      ...(options.commitmentClient ? { commitmentClient: options.commitmentClient } : {}),
      ...(options.budgetClient ? { budgetClient: options.budgetClient } : {}),
    },
    clock,
    app.log,
    options.scanTimeoutMs,
  );
  const scheduler = new ScanScheduler(store, runner, clock, app.log);

  const operatorOnly = { config: { operator: true } };
  const operatorGuard = async (request: FastifyRequest<{ Params: OrgParams }>, reply: FastifyReply) => {
    if (!isOperator(request, options.operatorToken) || isDemoOrg(request.params.orgId)) {
      return problem(reply, 403, "Forbidden");
    }
    const deletion = store.deletion(request.params.orgId);
    if (deletion) {
      return problem(reply, 410, "Gone", { deletedAt: deletion.deletedAt });
    }
    return undefined;
  };

  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
    const orgId = (request.params as Partial<OrgParams> | undefined)?.orgId;
    const operator =
      (request.routeOptions.config as { operator?: boolean } | undefined)?.operator === true &&
      isOperator(request, options.operatorToken);
    const session = sessionFromHeaders(request);
    const actorId = operator ? "operator" : session?.actorId;
    const boundOrgId = orgId ?? session?.orgId;
    request.log = request.log.child({
      ...(boundOrgId ? { orgId: boundOrgId } : {}),
      ...(actorId ? { actorId } : {}),
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        route: request.routeOptions.url ?? "unmatched",
        method: request.method,
        status: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      return reply.send(error);
    }
    const errorId = randomUUID();
    request.log.error({ err: error, errorId }, "unhandled error");
    return reply.code(500).type("application/problem+json").send({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      errorId,
    });
  });

  app.addHook("preHandler", async (request, reply) => {
    const orgId = (request.params as Partial<OrgParams> | undefined)?.orgId;
    const config = request.routeOptions.config as { operator?: boolean };
    if (!orgId || config.operator) {
      return undefined;
    }
    const session = sessionFromHeaders(request);
    if (!session || assertOrgAccess(session, orgId) !== "ok" || store.deletion(orgId)) {
      return undefined;
    }
    auditRetention(
      request.server.log.child({ reqId: request.id }),
      store.sweepRetention(clock(), orgId),
    );
    if (store.deletion(orgId) || NON_MUTATING_METHODS.has(request.method)) {
      return undefined;
    }
    const route = `${request.method} ${request.routeOptions.url?.replace(ORG_ROUTE_PREFIX, "") ?? ""}`;
    if (isDemoOrg(orgId)) {
      return DEMO_CANNED_POSTS.has(route) ? undefined : problem(reply, 403, "Demo is read-only");
    }
    if (READ_ONLY_EXEMPT.has(route) || !isReadOnly(store.snapshot(orgId).contract, clock())) {
      return undefined;
    }
    return problem(reply, 409, "Console read-only", {
      error: "console_read_only",
      attention: "scans paused",
    });
  });

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
    audit(request.log, "connection.connect");
    const asOf =
      request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>).asOf
        : undefined;
    scheduler.applySettings(request.params.orgId, clientTime(asOf));
    if (!canScan(store.snapshot(request.params.orgId).contract, clock())) {
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
      audit(request.log, "connection.disconnect");
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
    const scopes = [
      ...new Set(stored.resources.map((row) => scopeOf(stored.cloud, row.resourceUri))),
    ].filter(Boolean);
    store.putCoverage(request.params.orgId, coverageFromHarvest(scopes, launchCheckIds(stored.cloud)));
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
    if (!canScan(store.snapshot(request.params.orgId).contract, clock())) {
      return problem(reply, 409, "Scans paused", { attention: "scans paused" });
    }
    const connected = connectedSubscription(store, request.params.orgId, subscriptionId);
    if (!connected) {
      return problem(reply, 400, "Invalid scan", {
        errors: [{ path: "subscriptionId", message: "not a connected subscription" }],
      });
    }
    const scan = runner.start({ orgId: request.params.orgId, subscriptionId: connected, actor: "user" });
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
        now: clock(),
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
    const connected = connectedSubscription(store, request.params.orgId, subscriptionId);
    if (!connected) {
      return problem(reply, 400, "Invalid cost harvest", {
        errors: [{ path: "subscriptionId", message: "not a connected subscription" }],
      });
    }
    const billingScope = `/subscriptions/${connected}`;
    const harvested = await withProvider(reply, () =>
      harvestCost({
        client: guardProviderClient(request.params.orgId, options.costClient ?? unconfiguredCostClient()),
        subscriptionId: connected,
        billingScope,
        agreementType,
        asOf: clock(),
      }),
    );
    if (!harvested.ok) {
      return reply;
    }
    const costHarvest = harvested.value;
    store.putCoverage(
      request.params.orgId,
      applyCostCoverage(store.snapshot(request.params.orgId).coverage, costHarvest.coverage),
    );
    if (!costHarvest.ok) {
      store.putCost(request.params.orgId, null, connected);
      return sendClean(reply, 200, {
        harvested: false,
        reason: costHarvest.reason,
        closer: costHarvest.coverage[0]?.closer,
      });
    }
    store.putCost(request.params.orgId, costHarvest.snapshot, connected);
    return sendClean(reply, 200, { harvested: true, cost: costHarvest.snapshot });
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
    if (isDemoOrg(request.params.orgId)) {
      const org = store.snapshot(request.params.orgId);
      return sendClean(reply, 200, {
        harvested: true,
        commitments: org.commitments,
        findings: org.findings,
      });
    }
    const connected = connectedSubscription(store, request.params.orgId, subscriptionId);
    if (!connected) {
      return problem(reply, 400, "Invalid commitment harvest", {
        errors: [{ path: "subscriptionId", message: "not a connected subscription" }],
      });
    }
    const billingScope = `/subscriptions/${connected}`;
    const harvested = await withProvider(reply, () =>
      harvestCommitments({
        client: guardProviderClient(
          request.params.orgId,
          options.commitmentClient ?? unconfiguredCommitmentClient(),
        ),
        subscriptionId: connected,
        billingScope,
      }),
    );
    if (!harvested.ok) {
      return reply;
    }
    const commitmentHarvest = harvested.value;
    store.putCoverage(
      request.params.orgId,
      applyCommitmentCoverage(store.snapshot(request.params.orgId).coverage, commitmentHarvest.coverage),
    );
    if (!commitmentHarvest.ok) {
      store.putCommitments(request.params.orgId, null, connected);
      return sendClean(reply, 200, {
        harvested: false,
        reason: commitmentHarvest.reason,
        closer: commitmentHarvest.coverage[0]?.closer,
      });
    }
    store.putCommitments(request.params.orgId, commitmentHarvest.snapshot, connected);
    const commitmentFindings = mergeCommitmentFindings(
      store.snapshot(request.params.orgId).findings,
      commitmentHarvest.findings,
      connected,
    );
    store.putFindings(request.params.orgId, commitmentFindings);
    store.putIssues(
      request.params.orgId,
      applyScanToIssues({
        issues: store.snapshot(request.params.orgId).issues,
        findings: commitmentHarvest.findings,
        coverage: store.snapshot(request.params.orgId).coverage,
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
    const harvested = await withProvider(reply, () =>
      harvestBudgets({
        client: guardProviderClient(request.params.orgId, options.budgetClient ?? unconfiguredBudgetClient()),
        lastConfirmed: clock(),
      }),
    );
    if (!harvested.ok) {
      return reply;
    }
    const budgetHarvest = harvested.value;
    store.putCoverage(
      request.params.orgId,
      applyBudgetCoverage(store.snapshot(request.params.orgId).coverage, budgetHarvest.coverage),
    );
    store.putBudgets(request.params.orgId, budgetHarvest.snapshot);
    store.putFindings(
      request.params.orgId,
      mergeBudgetFindings(store.snapshot(request.params.orgId).findings, budgetHarvest.findings),
    );
    store.putIssues(
      request.params.orgId,
      applyScanToIssues({
        issues: store.snapshot(request.params.orgId).issues,
        findings: budgetHarvest.findings,
        coverage: store.snapshot(request.params.orgId).coverage,
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
    const rows = Array.isArray(body.rows) ? (body.rows as DailyCost[]) : null;
    if (!rows) {
      return problem(reply, 409, "No cost series");
    }
    const recipients = Array.isArray(body.recipients)
      ? body.recipients.filter((item): item is string => typeof item === "string")
      : [];
    const previous = Array.isArray(body.previous) ? (body.previous as SpendAlert[]) : [];
    const asOf =
      trustClientClock && typeof body.asOf === "string" ? body.asOf : clock().slice(0, 10);
    const analysis = analyzeAlerts({
      rows,
      asOf,
      recipients,
      previous,
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
    audit(request.log, "settings.change");
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
    if (!canScan(store.snapshot(request.params.orgId).contract, clock())) {
      emitDecision(app.log, { decision: "blocked", orgId: request.params.orgId, at: now });
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
    return sendClean(reply, 200, billingView(contract, clock()));
  });

  app.put<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/contract",
    { ...operatorOnly, preHandler: operatorGuard },
    async (request, reply) => {
      if (rejectSecrets(request.body, reply)) {
        return reply;
      }
      const now = clock();
      try {
        const parsed = parseContract(request.body, now);
        if (!parsed) {
          return problem(reply, 400, "Invalid contract", {
            errors: [{ path: "body", message: "plan and an ISO startDate are required" }],
          });
        }
        store.putContract(request.params.orgId, parsed);
        audit(request.log, "contract.change");
        return sendClean(reply, 200, billingView(parsed, now));
      } catch (error) {
        if (error instanceof CardDataError) {
          return problem(reply, 400, "Card data rejected");
        }
        throw error;
      }
    },
  );

  app.post<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/contract/advance",
    { ...operatorOnly, preHandler: operatorGuard },
    async (request, reply) => {
      const current = store.snapshot(request.params.orgId).contract;
      if (!current) {
        return problem(reply, 404, "Not found");
      }
      const body = (request.body as Record<string, unknown> | null) ?? {};
      const now = clock();
      const event =
        body.event === "failed_payment" || body.event === "paid" || body.event === "ended"
          ? body.event
          : undefined;
      const next = advanceContract(current, event ? { now, event } : { now });
      store.putContract(request.params.orgId, next);
      audit(request.log, "contract.change", { via: "advance" });
      return sendClean(reply, 200, billingView(next, now));
    },
  );

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/offboard", async (request, reply) => {
    const session = requireOrg(request, reply, store, { allowDeleted: true });
    if (!session) {
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
    const record = store.offboard(request.params.orgId, now, "customer", session.actorId);
    audit(request.log, "org.offboard", { trigger: record.trigger });
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
