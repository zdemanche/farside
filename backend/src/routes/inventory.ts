import { validateInventory, type Inventory } from "@farside/scan-contracts";
import { coverageFromHarvest } from "../coverage.js";
import { inventoriesFor } from "../estate.js";
import type { OrgParams, RoutePlugin } from "../http/context.js";
import { problem, cloudOf, sendClean, sendStored } from "../http/responses.js";
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
import type { Cloud } from "../cloud.js";

type BrowseQuery = Omit<InventoryFilters, "cloud"> & { cloud?: Cloud | "" };

export const inventoryRoutes: RoutePlugin = (ctx) => async (app) => {
  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/inventory",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const org = await ctx.store.read(request.params.orgId, "inventories", "inventory");
      const inventory = cloud ? inventoriesFor(org, cloud)[0] : org.inventory;
      return inventory ? sendStored(reply, 200, inventory) : problem(reply, 404, "Not found");
    },
  );

  app.get<{ Params: OrgParams }>(
    "/v1/orgs/:orgId/inventory/no-owner",
    { schema: { params: orgParams, querystring: cloudQuery } },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const inventories = inventoriesFor(
        await ctx.store.read(request.params.orgId, "inventories", "inventory"),
        cloud,
      );
      if (inventories.length === 0) {
        return problem(reply, 404, "Not found");
      }
      const totals = inventories.reduce(
        (sum, inventory) => {
          const next = noOwnerTotal(inventory);
          return {
            total: sum.total + next.total,
            resourceUris: [...sum.resourceUris, ...next.resourceUris],
          };
        },
        { total: 0, resourceUris: [] as string[] },
      );
      return sendClean(reply, 200, totals);
    },
  );

  app.get<{ Params: OrgParams; Querystring: BrowseQuery }>(
    "/v1/orgs/:orgId/inventory/browse",
    { schema: { params: orgParams, querystring: browseQuery } },
    async (request, reply) => {
      const cloud = cloudOf(request.query);
      const inventories = inventoriesFor(
        await ctx.store.read(request.params.orgId, "inventories", "inventory"),
        cloud,
      );
      if (inventories.length === 0) {
        return problem(reply, 404, "Not found");
      }
      const { owner, service, subscription, region } = request.query;
      const filters: InventoryFilters = {
        ...(owner === undefined ? {} : { owner }),
        ...(service === undefined ? {} : { service }),
        ...(subscription === undefined ? {} : { subscription }),
        ...(region === undefined ? {} : { region }),
        ...(cloud ? { cloud } : {}),
      };
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
        (await ctx.store.read(orgId, "settings")).settings.ownerTagKey,
      );
      const stored = await ctx.store.putInventory(orgId, tagged);
      const scopes = [
        ...new Set(stored.resources.map((row) => scopeOf(stored.cloud, row.resourceUri))),
      ].filter(Boolean);
      const provider = providerFor(stored.cloud);
      await ctx.store.putCoverage(
        orgId,
        coverageFromHarvest(scopes, provider.launchCheckIds, provider.harvestAssessedCheckIds),
      );
      return sendClean(reply, 200, stored);
    },
  );
};
