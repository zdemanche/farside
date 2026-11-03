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
import {
  applyCostCoverage,
  defaultCostClient,
  harvestCost,
  type CostQueryClient,
} from "./cost.js";
import { estateOverview } from "./estate.js";
import { applyOwnerTag, filterInventory, groupInventory, noOwnerTotal } from "./inventory.js";
import { SecretLeakError, assertNoSecrets } from "./secrets.js";
import { defaultHarvester, ScanRunner, toScanView, toScanViews, type Harvester } from "./scans.js";
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
  options: { harvester?: Harvester; costClient?: CostQueryClient } = {},
) {
  const runner = new ScanRunner(store, options.harvester ?? defaultHarvester());
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    status: "ok" as const,
    service: SERVICE_NAME,
  }));

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    const inventory = store.snapshot(request.params.orgId).inventory;
    if (!inventory) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, inventory);
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory/no-owner", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    const inventory = store.snapshot(request.params.orgId).inventory;
    if (!inventory) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, noOwnerTotal(inventory));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/connections", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    return sendClean(reply, 200, { connections: store.snapshot(request.params.orgId).connections });
  });

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/connections", async (request, reply) => {
    if (!requireOrg(request, reply)) {
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
      if (!requireOrg(request, reply)) {
        return reply;
      }
      if (!store.deleteConnection(request.params.orgId, request.params.connectionId)) {
        return problem(reply, 404, "Not found");
      }
      return reply.code(204).send();
    },
  );

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory", async (request, reply) => {
    if (!requireOrg(request, reply)) {
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
    if (!requireOrg(request, reply)) {
      return reply;
    }
    const org = store.snapshot(request.params.orgId);
    const health = coverageHealth(org.coverage, org.findings);
    return sendClean(reply, 200, {
      coverage: toContractCoverage(org.coverage),
      entries: org.coverage,
      health,
      formula: HEALTH_SCORE_FORMULA,
    });
  });

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/coverage", async (request, reply) => {
    if (!requireOrg(request, reply)) {
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
    if (!requireOrg(request, reply)) {
      return reply;
    }
    const org = store.snapshot(request.params.orgId);
    const spots = blindSpots(org.coverage);
    const health = coverageHealth(org.coverage, org.findings);
    return sendClean(reply, 200, { spots, health, formula: HEALTH_SCORE_FORMULA });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/scans", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    return sendClean(reply, 200, { scans: toScanViews(store.snapshot(request.params.orgId).scans) });
  });

  app.get<{ Params: { orgId: string; scanId: string } }>(
    "/v1/orgs/:orgId/scans/:scanId",
    async (request, reply) => {
      if (!requireOrg(request, reply)) {
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
    if (!requireOrg(request, reply)) {
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
    const scan = runner.start({ orgId: request.params.orgId, subscriptionId, actor });
    return sendClean(reply, scan.started ? 202 : 200, {
      scan: toScanView(scan.job, false),
      scanStarted: scan.started,
    });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/findings", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    return sendClean(reply, 200, { findings: store.snapshot(request.params.orgId).findings });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/issues", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    return sendClean(reply, 200, { issues: store.snapshot(request.params.orgId).issues });
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/cost", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    const cost = store.snapshot(request.params.orgId).cost;
    if (!cost) {
      return problem(reply, 404, "Not found");
    }
    return sendClean(reply, 200, cost);
  });

  app.post<{ Params: OrgParams }>("/v1/orgs/:orgId/cost", async (request, reply) => {
    if (!requireOrg(request, reply)) {
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
    const harvested = await harvestCost({
      client: options.costClient ?? defaultCostClient(),
      subscriptionId,
      billingScope,
      agreementType,
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

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/estate", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    return sendClean(reply, 200, estateOverview(store.snapshot(request.params.orgId)));
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/settings", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    return sendClean(reply, 200, store.snapshot(request.params.orgId).settings);
  });

  app.put<{ Params: OrgParams }>("/v1/orgs/:orgId/settings", async (request, reply) => {
    if (!requireOrg(request, reply)) {
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
    const saved = store.putSettings(request.params.orgId, {
      ...parsed,
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    return sendClean(reply, 200, saved);
  });

  app.get<{ Params: OrgParams }>("/v1/orgs/:orgId/inventory/browse", async (request, reply) => {
    if (!requireOrg(request, reply)) {
      return reply;
    }
    const inventory = store.snapshot(request.params.orgId).inventory;
    if (!inventory) {
      return problem(reply, 404, "Not found");
    }
    const query = request.query as Record<string, unknown>;
    const filters: {
      owner?: string;
      service?: string;
      subscription?: string;
      region?: string;
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
    const resources = filterInventory(inventory, filters);
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
