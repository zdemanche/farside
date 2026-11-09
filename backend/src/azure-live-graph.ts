import type { Cloud } from "@farside/scan-contracts";
import {
  ARM_ORIGIN,
  AzureAccessDeniedError,
  AzureApiError,
  SUBSCRIPTION_ID,
  armJson,
  type ArmOptions,
  type FetchLike,
  type TokenProvider,
} from "./azure-live.js";
import { accessTokenClaims, isGuid } from "./azure-federated.js";
import type { HierarchyClient, HierarchySubscription, ManagementGroup } from "./hierarchy.js";
import {
  ResourceGraphFailedCallError,
  ResourceGraphThrottleError,
  type ResourceGraphClient,
  type ResourceGraphRow,
} from "./resource-graph.js";
import { defaultRoleLister, type RoleLister } from "./role-probe.js";

/**
 * Live Resource Graph, hierarchy, role and backup reads (#58, #59, #60, #55). Request and
 * response shapes follow Microsoft's public REST reference and have NOT been run against a live
 * subscription. They share the token, origin, retry and timeout rules of azure-live.ts.
 */
export const ARG_API_VERSION = "2022-10-01";
export const ARG_URL = `${ARM_ORIGIN}/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API_VERSION}`;
export const AUTHORIZATION_API_VERSION = "2022-04-01";
const ARG_TOP = 1000;
const MAX_PAGES = 50;
const DAY_MS = 86_400_000;
const BASE_KEYS = new Set(["id", "type", "name", "location", "subscriptionId", "tags"]);
const ROLE_DEFINITION =
  /^(\/subscriptions\/[A-Za-z0-9-]{1,64})?\/providers\/Microsoft\.Authorization\/roleDefinitions\/[0-9a-f-]{36}$/i;

type Scalar = string | number | boolean | null;
type ArgBody = { data?: unknown; $skipToken?: unknown };

export const PROTECTED_ITEMS_QUERY =
  "RecoveryServicesResources | where type =~ 'microsoft.recoveryservices/vaults/backupfabrics/protectioncontainers/protecteditems' | project sourceResourceId = tolower(tostring(properties.sourceResourceId)), vaultId = tostring(split(tolower(id), '/backupfabrics/')[0])";
export const MANAGEMENT_GROUPS_QUERY =
  "ResourceContainers | where type =~ 'microsoft.management/managementgroups' | project groupId = name, displayName = tostring(properties.displayName), parentId = tostring(properties.details.parent.name)";
export const SUBSCRIPTIONS_QUERY =
  "ResourceContainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId, displayName = name, tenantId, managementGroupId = tostring(properties.managementGroupAncestorsChain[0].name)";

function isScalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

async function argPage(
  options: ArmOptions,
  query: string,
  scope: { subscriptions?: string[] },
  skipToken?: string,
): Promise<{ rows: Record<string, unknown>[]; skipToken?: string }> {
  const body = (await armJson(options, "POST", ARG_URL, {
    ...scope,
    query,
    options: { resultFormat: "objectArray", $top: ARG_TOP, ...(skipToken ? { $skipToken: skipToken } : {}) },
  })) as ArgBody;
  if (!Array.isArray(body.data)) {
    throw new AzureApiError(502);
  }
  const rows = body.data.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
  const next = typeof body.$skipToken === "string" && body.$skipToken.length > 0 ? body.$skipToken : undefined;
  return next ? { rows, skipToken: next } : { rows };
}

async function argAll(options: ArmOptions, query: string, scope: { subscriptions?: string[] }) {
  const rows: Record<string, unknown>[] = [];
  let skipToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const next = await argPage(options, query, scope, skipToken);
    rows.push(...next.rows);
    if (!next.skipToken) {
      return rows;
    }
    skipToken = next.skipToken;
  }
  throw new Error("Resource Graph query exceeded page limit");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function wholeDays(from: number, to: number): number {
  return Math.floor((to - from) / DAY_MS);
}

type PoolShape = {
  properties?: { backendIPConfigurations?: unknown[]; loadBalancerBackendAddresses?: unknown[] };
};

function backendAddressCount(pools: string): number | null {
  try {
    const parsed = JSON.parse(pools) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return (parsed as PoolShape[]).reduce(
      (sum, pool) =>
        sum +
        Math.max(
          pool.properties?.backendIPConfigurations?.length ?? 0,
          pool.properties?.loadBalancerBackendAddresses?.length ?? 0,
        ),
      0,
    );
  } catch {
    return null;
  }
}

/**
 * Turns the aliased columns from `TYPE_PROJECTION` into the fact fields the checks read.
 * Returns null for rows Farside must not judge (the SQL `master` system database).
 */
export function normaliseLiveRow(raw: Record<string, unknown>, now: Date): ResourceGraphRow | null {
  const id = text(raw.id);
  const type = text(raw.type);
  if (!id || !type) {
    return null;
  }
  const name = text(raw.name);
  const lowerType = type.toLowerCase();
  if (lowerType === "microsoft.sql/servers/databases" && name.toLowerCase() === "master") {
    return null;
  }
  const tags: Record<string, string> = {};
  if (typeof raw.tags === "object" && raw.tags !== null) {
    for (const [key, value] of Object.entries(raw.tags)) {
      if (typeof value === "string") {
        tags[key] = value;
      }
    }
  }
  const properties: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!BASE_KEYS.has(key) && isScalar(value)) {
      properties[key] = value;
    }
  }
  if (typeof properties.powerState === "string") {
    properties.powerState = properties.powerState.replace(/^PowerState\//i, "").toLowerCase();
  }
  if (properties.associatedTo === "") {
    properties.associatedTo = null;
  }
  if (properties.attachedTo === "") {
    properties.attachedTo = null;
  }
  const created = Date.parse(text(properties.timeCreated));
  if (Number.isFinite(created)) {
    properties.ageDays = wholeDays(created, now.getTime());
  }
  const expires = Date.parse(text(properties.expirationDate));
  if (Number.isFinite(expires)) {
    properties.daysRemaining = wholeDays(now.getTime(), expires);
  } else {
    delete properties.expirationDate;
  }
  if (typeof properties.backendPools === "string") {
    const count = backendAddressCount(properties.backendPools);
    if (count !== null) {
      properties.backendAddressCount = count;
    }
    delete properties.backendPools;
  }
  for (const key of ["certificateName", "hostName", "kind", "skuName", "backupRedundancy"]) {
    if (properties[key] === "") {
      delete properties[key];
    }
  }
  return {
    id,
    type,
    name,
    location: text(raw.location),
    subscriptionId: text(raw.subscriptionId),
    tags,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

function checkSubscription(subscriptionId: string): void {
  if (!SUBSCRIPTION_ID.test(subscriptionId)) {
    throw new Error("not a subscription id");
  }
}

/** Live `ResourceGraphClient` for one subscription. Throttling is kept apart from other failures. */
export function liveResourceGraphClient(options: ArmOptions): ResourceGraphClient {
  const now = () => (options.now ?? (() => new Date()))();
  return {
    async query(input) {
      checkSubscription(input.subscriptionId);
      try {
        const page = await argPage(options, input.query, { subscriptions: [input.subscriptionId] }, input.skipToken);
        const data = page.rows
          .map((row) => normaliseLiveRow(row, now()))
          .filter((row): row is ResourceGraphRow => row !== null);
        return page.skipToken ? { data, skipToken: page.skipToken } : { data };
      } catch (error) {
        if (error instanceof AzureApiError && error.status === 429) {
          throw new ResourceGraphThrottleError();
        }
        throw new ResourceGraphFailedCallError();
      }
    },
  };
}

/** Management groups and subscriptions the token can see, from `ResourceContainers`. */
export function liveHierarchyClient(options: ArmOptions): HierarchyClient {
  return {
    async listManagementGroups(): Promise<ManagementGroup[]> {
      const rows = await argAll(options, MANAGEMENT_GROUPS_QUERY, {});
      return rows
        .filter((row) => text(row.groupId))
        .map((row) => ({
          id: text(row.groupId),
          displayName: text(row.displayName) || text(row.groupId),
          parentId: text(row.parentId) || null,
        }));
    },
    async listSubscriptions(): Promise<HierarchySubscription[]> {
      const rows = await argAll(options, SUBSCRIPTIONS_QUERY, {});
      return rows
        .filter((row) => text(row.subscriptionId))
        .map((row) => ({
          id: text(row.subscriptionId),
          displayName: text(row.displayName),
          tenantId: text(row.tenantId),
          managementGroupId: text(row.managementGroupId),
        }));
    },
  };
}

export type ProtectedItems = Map<string, string>;

/** Resource ids (lower case) with an Azure Backup protected item, mapped to the vault id. */
export async function liveProtectedItems(options: ArmOptions, subscriptionId: string): Promise<ProtectedItems> {
  checkSubscription(subscriptionId);
  const rows = await argAll(options, PROTECTED_ITEMS_QUERY, { subscriptions: [subscriptionId] });
  const items: ProtectedItems = new Map();
  for (const row of rows) {
    const source = text(row.sourceResourceId).toLowerCase();
    if (source) {
      items.set(source, text(row.vaultId));
    }
  }
  return items;
}

type AssignmentsBody = {
  value?: Array<{ properties?: { roleDefinitionId?: unknown } }>;
  nextLink?: string | null;
};

async function assignedRoleDefinitions(options: ArmOptions, subscriptionId: string, principalId: string) {
  const ids = new Set<string>();
  const filter = encodeURIComponent(`assignedTo('${principalId}')`);
  let url: string | undefined =
    `${ARM_ORIGIN}/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleAssignments?api-version=${AUTHORIZATION_API_VERSION}&$filter=${filter}`;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const body = (await armJson(options, "GET", url)) as AssignmentsBody;
    for (const assignment of body.value ?? []) {
      const id = assignment.properties?.roleDefinitionId;
      if (typeof id === "string" && ROLE_DEFINITION.test(id)) {
        ids.add(id);
      }
    }
    url = body.nextLink ?? undefined;
  }
  if (url) {
    throw new Error("role assignments exceeded page limit");
  }
  return [...ids];
}

/**
 * Role names held by Farside's service principal on one subscription. The principal is the
 * `oid` claim of the federated token for that tenant. A refused listing means Reader is
 * missing, so it returns no roles rather than guessing.
 */
export function liveRoleLister(options: {
  tokenFor: (tenantId: string) => TokenProvider;
  fetch?: FetchLike;
  fallback?: RoleLister;
}): RoleLister {
  const fallback = options.fallback ?? defaultRoleLister();
  return {
    async list(input: { tenantId: string; subscriptionId: string; cloud: Cloud }) {
      if (input.cloud !== "azure") {
        return fallback.list(input);
      }
      checkSubscription(input.subscriptionId);
      const token = options.tokenFor(input.tenantId);
      const arm: ArmOptions = { token, ...(options.fetch ? { fetch: options.fetch } : {}) };
      const { oid } = accessTokenClaims(await token());
      if (!oid || !isGuid(oid)) {
        throw new Error("federated token has no service principal object id");
      }
      let definitions: string[];
      try {
        definitions = await assignedRoleDefinitions(arm, input.subscriptionId, oid);
      } catch (error) {
        if (error instanceof AzureAccessDeniedError) {
          return [];
        }
        throw error;
      }
      const names = new Set<string>();
      for (const id of definitions) {
        const body = (await armJson(arm, "GET", `${ARM_ORIGIN}${id}?api-version=${AUTHORIZATION_API_VERSION}`)) as {
          properties?: { roleName?: unknown };
        };
        if (typeof body.properties?.roleName === "string") {
          names.add(body.properties.roleName);
        }
      }
      return [...names].sort();
    },
  };
}
