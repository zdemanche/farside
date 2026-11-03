import { validateInventory, type Inventory } from "@farside/scan-contracts";
import { coverageFromHarvest } from "../coverage.js";
import { inventoriesFor } from "../estate.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { problem, readCloud, sendClean } from "../http/responses.js";
import { browseQuery, cloudQuery, inventoryBody, orgParams } from "../http/schemas.js";
import {
  applyOwnerTag,
  browseInventories,
  groupInventory,
  noOwnerTotal,
  projectInventory,
  type InventoryFilters,
} from "../inventory.js";
import { providerFor } from "../providers/index.js";
import { scopeOf } from "../scope.js";

const FILTER_KEYS = ["owner", "service", "subscription", "region"] as const;

export const inventoryRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/inventory",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = readCloud(request.query, reply);
      if (!cloud.ok) {
        return reply;
      }
      const org = ctx.store.snapshot(request.params.orgId);
      const inventory = cloud.cloud ? inventoriesFor(org, cloud.cloud)[0] : org.inventory;
      return inventory ? sendClean(reply, 200, inventory) : problem(reply, 404, "Not found");
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/inventory/no-owner",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = readCloud(request.query, reply);
      if (!cloud.ok) {
        return reply;
      }
      const inventories = inventoriesFor(ctx.store.snapshot(request.params.orgId), cloud.cloud);
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
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/inventory/browse",
    { schema: { params: orgParams, querystring: browseQuery } },
    async (request, reply) => {
      const cloud = readCloud(request.query, reply);
      if (!cloud.ok) {
        return reply;
      }
      const inventories = inventoriesFor(ctx.store.snapshot(request.params.orgId), cloud.cloud);
      if (inventories.length === 0) {
        return problem(reply, 404, "Not found");
      }
      const query = request.query as Record<string, unknown>;
      const filters: InventoryFilters = {};
      for (const key of FILTER_KEYS) {
        const value = query[key];
        if (typeof value === "string") {
          filters[key] = value;
        }
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
    },
  );

  app.put<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/inventory",
    {
      schema: { params: orgParams, body: inventoryBody },
      config: { rejectSecrets: true, invalidTitle: "Invalid inventory" },
    },
    async (request, reply) => {
      const errors = validateInventory(request.body);
      if (errors.length > 0) {
        return problem(reply, 400, "Invalid inventory", { errors });
      }
      const { orgId } = request.params;
      const tagged = applyOwnerTag(
        projectInventory(request.body as Inventory),
        ctx.store.snapshot(orgId).settings.ownerTagKey,
      );
      const stored = ctx.store.putInventory(orgId, tagged);
      const scopes = [
        ...new Set(stored.resources.map((row) => scopeOf(stored.cloud, row.resourceUri))),
      ].filter(Boolean);
      const provider = providerFor(stored.cloud);
      ctx.store.putCoverage(
        orgId,
        coverageFromHarvest(scopes, provider.launchCheckIds, provider.harvestAssessedCheckIds),
      );
      return sendClean(reply, 200, stored);
    },
  );
};
