import { canScan } from "../billing.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { problem, cloudOf, requireConnected, sendClean } from "../http/responses.js";
import {
  DEFAULT_SCAN_PAGE,
  MAX_SCAN_PAGE,
  orgParams,
  scanBody,
  scanParams,
  scansQuery,
  tickBody,
} from "../http/schemas.js";
import { emitDecision } from "../observability.js";
import { findScanView, toScanView, toScanViews } from "../scans.js";
import type { Cloud } from "../cloud.js";

type ScansQuery = { cloud?: Cloud | ""; limit?: string; before?: string };

export const scanRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams; Querystring: ScansQuery }>(
    "/v1/orgs/:orgId/scans",
    { schema: { params: orgParams, querystring: scansQuery } },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const limit = Math.min(Number(request.query.limit ?? DEFAULT_SCAN_PAGE), MAX_SCAN_PAGE);
      const { before } = request.query;
      const views = toScanViews((await ctx.store.read(request.params.orgId, "scans")).scans);
      const end =
        before === undefined ? views.length : views.findIndex((scan) => scan.id === before);
      if (end < 0) {
        return problem(reply, 400, "Invalid cursor", {
          errors: [{ path: "before", message: "not a known scan" }],
        });
      }
      const matching = views
        .slice(0, end)
        .filter((scan) => cloud == null || scan.cloud === cloud);
      const scans = matching.slice(-limit);
      const current = before === undefined ? matching.find((scan) => scan.current) : undefined;
      return sendClean(reply, 200, {
        scans: current && !scans.includes(current) ? [current, ...scans] : scans,
      });
    },
  );

  app.get<{ Params: { orgId: string; scanId: string } }>(
    "/v1/orgs/:orgId/scans/:scanId",
    { schema: { params: scanParams } },
    async (request, reply) => {
      const view = findScanView(
        (await ctx.store.read(request.params.orgId, "scans")).scans,
        request.params.scanId,
      );
      return view ? sendClean(reply, 200, view) : problem(reply, 404, "Not found");
    },
  );

  app.post<{ Params: OrgParams; Body: { subscriptionId: string } }>(
    "/v1/orgs/:orgId/scans",
    {
      schema: { params: orgParams, body: scanBody },
      config: {
        invalidTitle: "Invalid scan",
        demo: async (store, orgId) => {
          const job = (await store.read(orgId, "scans")).scans[0];
          return job
            ? { status: 200, body: { scan: toScanView(job, true), scanStarted: false } }
            : null;
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      if (!canScan((await ctx.store.read(orgId, "contract")).contract, ctx.clock())) {
        return problem(reply, 409, "Scans paused", { attention: "scans paused" });
      }
      const connected = await requireConnected(
        ctx,
        request,
        reply,
        request.body.subscriptionId,
        "Invalid scan",
      );
      if (!connected) {
        return reply;
      }
      const scan = await ctx.runner.start({ orgId, subscriptionId: connected, actor: "user" });
      return sendClean(reply, scan.started ? 202 : 200, {
        scan: toScanView(scan.job, false),
        scanStarted: scan.started,
      });
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/schedule",
    { schema: { params: orgParams } },
    async (request, reply) => {
      const org = await ctx.store.read(request.params.orgId, "connections", "schedule", "settings");
      const attention =
        org.connections.length === 0 || org.connections.every((item) => !item.healthy)
          ? "connection needs attention"
          : null;
      return sendClean(reply, 200, {
        ...org.schedule,
        enabled: org.settings.scanScheduleEnabled,
        intervalHours: org.settings.scanIntervalHours,
        retryLimit: org.settings.scanRetryLimit,
        attention,
      });
    },
  );

  app.post<{ Params: OrgParams; Body: { now?: string } }>(
    "/v1/orgs/:orgId/schedule/tick",
    { schema: { params: orgParams, body: tickBody }, config: { invalidTitle: "Invalid tick" } },
    async (request, reply) => {
      const { orgId } = request.params;
      const now = ctx.clientTime(request.body.now);
      if (!canScan((await ctx.store.read(orgId, "contract")).contract, ctx.clock())) {
        emitDecision(ctx.log, { decision: "blocked", orgId, at: now });
        return sendClean(reply, 200, {
          action: "blocked",
          attention: "scans paused",
          record: null,
          scan: null,
          scanStarted: false,
          schedule: (await ctx.store.read(orgId, "schedule")).schedule,
        });
      }
      const tick = await ctx.scheduler.tick(orgId, now);
      return sendClean(reply, 200, {
        action: tick.action,
        attention: tick.attention,
        record: tick.record,
        scan: tick.scan ? toScanView(tick.scan, false) : null,
        scanStarted: tick.scanStarted,
        schedule: tick.schedule,
      });
    },
  );
};
