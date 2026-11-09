import { ENTRA_ORIGIN } from "./azure-federated.js";
import { ARM_ORIGIN, type FetchLike } from "./azure-live.js";
import { ARG_URL } from "./azure-live-graph.js";
import type { GroundTruthItem, GroundTruthManifest } from "./inventory.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };

/**
 * A fake Entra + ARM endpoint built from the ground-truth manifest, shaped like Microsoft's
 * public REST reference. Tests and the live-run tests use it so live code paths run end to end
 * without a network. It is not evidence that Azure answers this way.
 */
export const FAKE_TENANT_ID = "33333333-3333-4333-8333-333333333333";
export const FAKE_HOME_TENANT_ID = "44444444-4444-4444-8444-444444444444";
export const FAKE_CLIENT_ID = "55555555-5555-4555-8555-555555555555";
export const FAKE_PRINCIPAL_ID = "66666666-6666-4666-8666-666666666666";
export const FAKE_SUBSCRIPTIONS = {
  main: "11111111-1111-4111-8111-111111111111",
  "empty-no-budget": "22222222-2222-4222-8222-222222222222",
} as const;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 3;

export type FakeArea = "graph" | "backup" | "metrics" | "cost" | "budgets" | "roles" | "token";

export type FakeAzureOptions = {
  now: () => Date;
  tenantId?: string;
  principalId?: string;
  subscriptions?: Record<string, string>;
  roles?: readonly string[];
  /** HTTP status to return for every call in that area. */
  fail?: Partial<Record<FakeArea, number>>;
  manifest?: GroundTruthManifest;
  tokenLifetimeSeconds?: number;
};

export type FakeAzure = {
  fetch: FetchLike;
  calls: Array<{ url: string; method: string; body: string }>;
  tokensIssued: () => number;
  accessToken: string;
};

export function fakeJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJlLW5vdC1jaGVja2Vk`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function uriOf(item: GroundTruthItem, subscriptionId: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/farside-seed/providers/${item.type}/${item.id}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The aliased columns `TYPE_PROJECTION` asks for, as Resource Graph would return them. */
function rawRow(item: GroundTruthItem, subscriptionId: string, now: number): Record<string, unknown> {
  const p = item.properties ?? {};
  const base = {
    id: uriOf(item, subscriptionId),
    type: item.type,
    name: item.id,
    location: "eastus",
    subscriptionId,
    tags: item.tags,
  };
  const num = (key: string, fallback: number) => (typeof p[key] === "number" ? (p[key] as number) : fallback);
  switch (item.type) {
    case "Microsoft.Compute/disks":
      return {
        ...base,
        diskState: p.diskState ?? null,
        sizeGb: p.sizeGb ?? 32,
        skuName: "StandardSSD_LRS",
        attachedTo: p.attachedTo ? `/subscriptions/${subscriptionId}/x/virtualMachines/${String(p.attachedTo)}` : "",
      };
    case "Microsoft.Network/publicIPAddresses":
      return {
        ...base,
        associatedTo: p.associatedTo ? `/subscriptions/${subscriptionId}/x/ipConfigurations/${String(p.associatedTo)}` : "",
        skuName: "Standard",
      };
    case "Microsoft.Compute/snapshots":
      return { ...base, timeCreated: iso(now - num("ageDays", 0) * DAY_MS - 3_600_000), sizeGb: 32 };
    case "Microsoft.Compute/virtualMachines":
      return {
        ...base,
        vmSize: p.vmSize ?? "Standard_D2s_v5",
        powerState: p.powerState ? `PowerState/${String(p.powerState)}` : "",
      };
    case "Microsoft.Web/serverfarms":
      return { ...base, numberOfSites: p.numberOfSites ?? 0, skuName: p.skuName ?? "S1", kind: "app" };
    case "Microsoft.Network/loadBalancers":
      return {
        ...base,
        backendPools: JSON.stringify([
          { properties: { backendIPConfigurations: Array.from({ length: num("backendAddressCount", 0) }, (_, i) => ({ id: `ip${i}` })) } },
        ]),
        skuName: p.skuName ?? "Standard",
      };
    case "Microsoft.Network/natGateways":
      return { ...base, attachedSubnetCount: num("attachedSubnetCount", 0), skuName: "Standard" };
    case "Microsoft.Sql/servers/databases":
      return {
        ...base,
        zoneRedundant: p.zoneRedundant ?? true,
        backupRedundancy: p.backupRedundancy ?? "Geo",
        skuName: "S0",
      };
    case "Microsoft.Web/certificates":
      return {
        ...base,
        expirationDate: iso(now + num("daysRemaining", 0) * DAY_MS + 3_600_000),
        hostName: p.hostName ?? "",
      };
    case "Microsoft.Network/applicationGateways":
      // ARM has no certificate expiry on the gateway itself, so none is returned here either.
      return { ...base, certificateName: p.certificateName ?? "" };
    default:
      return base;
  }
}

const ROLE_IDS: Record<string, string> = {
  Reader: "acdd72a7-3385-48ef-bd42-f606fba81ae7",
  "Cost Management Reader": "72fafb9e-0641-4937-9268-a91bfd8191a3",
  "Monitoring Reader": "43d0d8ad-25c7-4714-9337-8ba259a9fe05",
  "Reservations Reader": "582fc458-8989-419f-a480-75249bc5db7e",
  "Backup Reader": "a795c7a0-d4a2-40c1-ae25-d81f01202912",
};

export function fakeAzure(options: FakeAzureOptions): FakeAzure {
  const manifest = options.manifest ?? (docAzureGroundTruth as GroundTruthManifest);
  const tenantId = options.tenantId ?? FAKE_TENANT_ID;
  const subscriptions: Record<string, string> = options.subscriptions ?? { ...FAKE_SUBSCRIPTIONS };
  const roles = options.roles ?? Object.keys(ROLE_IDS);
  const accessToken = fakeJwt({ tid: tenantId, oid: options.principalId ?? FAKE_PRINCIPAL_ID, aud: ARM_ORIGIN });
  const calls: FakeAzure["calls"] = [];
  let issued = 0;
  const aliasOf = (id: string) => Object.keys(subscriptions).find((alias) => subscriptions[alias]?.toLowerCase() === id.toLowerCase());
  const itemsIn = (subscriptionId: string) => {
    const alias = aliasOf(subscriptionId);
    return alias ? manifest.items.filter((item) => item.subscription === alias) : [];
  };
  const failure = (area: FakeArea) => options.fail?.[area];

  function graph(body: { query: string; subscriptions?: string[]; options?: { $skipToken?: string } }) {
    const now = options.now().getTime();
    const scoped = body.subscriptions ?? Object.values(subscriptions);
    let rows: Record<string, unknown>[];
    if (body.query.startsWith("RecoveryServicesResources")) {
      if (failure("backup")) {
        return json({ error: { code: "AuthorizationFailed" } }, failure("backup"));
      }
      rows = scoped.flatMap((id) =>
        itemsIn(id)
          .filter((item) => item.properties?.protected === true)
          .map((item) => ({
            sourceResourceId: uriOf(item, id).toLowerCase(),
            vaultId: `/subscriptions/${id}/resourcegroups/farside-seed/providers/microsoft.recoveryservices/vaults/${String(item.properties?.vaultId ?? "vault")}`,
          })),
      );
    } else if (body.query.includes("microsoft.management/managementgroups")) {
      rows = [
        { groupId: tenantId, displayName: "Tenant Root Group", parentId: "" },
        { groupId: "mg-farside-test", displayName: "Farside test estate", parentId: tenantId },
      ];
    } else if (body.query.includes("microsoft.resources/subscriptions")) {
      rows = Object.entries(subscriptions).map(([alias, id]) => ({
        subscriptionId: id,
        displayName: alias,
        tenantId,
        managementGroupId: "mg-farside-test",
      }));
    } else {
      if (failure("graph")) {
        return json({ error: { code: "Failed" } }, failure("graph"));
      }
      const type = /where type =~ '([^']+)'/.exec(body.query)?.[1]?.toLowerCase();
      rows = scoped.flatMap((id) =>
        itemsIn(id)
          .filter((item) => item.type.toLowerCase() === type)
          .map((item) => rawRow(item, id, now)),
      );
      if (type === "microsoft.sql/servers/databases") {
        rows.push(...scoped.map((id) => ({ id: `/subscriptions/${id}/x/databases/master`, type: "Microsoft.Sql/servers/databases", name: "master", location: "eastus", subscriptionId: id, tags: {} })));
      }
    }
    const offset = Number(body.options?.$skipToken ?? 0);
    const page = rows.slice(offset, offset + PAGE_SIZE);
    const next = offset + PAGE_SIZE < rows.length ? { $skipToken: String(offset + PAGE_SIZE) } : {};
    return json({ totalRecords: rows.length, count: page.length, data: page, ...next });
  }

  function metrics(path: string) {
    if (failure("metrics")) {
      return json({}, failure("metrics"));
    }
    const subscriptionId = path.split("/")[2] ?? "";
    const item = itemsIn(subscriptionId).find((candidate) => path.startsWith(uriOf(candidate, subscriptionId)));
    const total = typeof item?.properties?.byteCount === "number" ? item.properties.byteCount : undefined;
    return json({ value: [{ timeseries: total === undefined ? [] : [{ data: [{ total }] }] }] });
  }

  function cost() {
    if (failure("cost")) {
      return json({}, failure("cost"));
    }
    const now = options.now();
    const rows: unknown[] = [];
    for (let back = 3; back >= 0; back -= 1) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, back === 0 ? 1 : 15));
      const day = Number(month.toISOString().slice(0, 10).replace(/-/g, ""));
      rows.push([12.5 + back, day, "Virtual Machines", "USD"], [3.25, day, "Storage", "USD"]);
    }
    return json({
      properties: { columns: [{ name: "Cost" }, { name: "UsageDate" }, { name: "ServiceName" }, { name: "Currency" }], rows },
    });
  }

  function budgets(subscriptionId: string) {
    if (failure("budgets")) {
      return json({}, failure("budgets"));
    }
    const names = itemsIn(subscriptionId)
      .filter((item) => item.type === "Microsoft.Consumption/budgets")
      .flatMap((item) => {
        const value: unknown = item.properties?.budgetNames;
        return Array.isArray(value) ? value.map(String) : [];
      });
    return json({ value: names.map((name) => ({ name })) });
  }

  function roleAssignments(subscriptionId: string) {
    if (failure("roles")) {
      return json({}, failure("roles"));
    }
    return json({
      value: roles.map((role) => ({
        properties: { roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_IDS[role]}` },
      })),
    });
  }

  const fetch: FetchLike = async (input, init) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url: input, method, body });
    if (input.startsWith(`${ENTRA_ORIGIN}/`)) {
      if (failure("token")) {
        return json({ error: "invalid_client", error_codes: [700016] }, failure("token"));
      }
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "client_credentials" || !form.get("client_assertion")) {
        return json({ error: "invalid_request" }, 400);
      }
      issued += 1;
      return json({ token_type: "Bearer", expires_in: options.tokenLifetimeSeconds ?? 3599, access_token: accessToken });
    }
    if (!input.startsWith(`${ARM_ORIGIN}/`)) {
      throw new Error(`fake Azure refuses ${input}`);
    }
    const headers = init.headers as Record<string, string>;
    if (headers.authorization !== `Bearer ${accessToken}`) {
      return json({ error: { code: "InvalidAuthenticationToken" } }, 401);
    }
    const url = new URL(input);
    const path = url.pathname;
    if (input.startsWith(ARG_URL)) {
      return graph(JSON.parse(body) as Parameters<typeof graph>[0]);
    }
    if (path.endsWith("/providers/microsoft.insights/metrics")) {
      return metrics(path);
    }
    if (path.endsWith("/providers/Microsoft.CostManagement/query")) {
      return cost();
    }
    if (path.endsWith("/providers/Microsoft.Consumption/budgets")) {
      return budgets(path.split("/")[2] ?? "");
    }
    if (path.endsWith("/providers/Microsoft.Authorization/roleAssignments")) {
      return roleAssignments(path.split("/")[2] ?? "");
    }
    const definition = /roleDefinitions\/([0-9a-f-]{36})$/.exec(path)?.[1];
    if (definition) {
      const roleName = Object.keys(ROLE_IDS).find((name) => ROLE_IDS[name] === definition);
      return roleName ? json({ properties: { roleName } }) : json({}, 404);
    }
    return json({ error: { code: "NotFound" } }, 404);
  };

  return { fetch, calls, tokensIssued: () => issued, accessToken };
}
