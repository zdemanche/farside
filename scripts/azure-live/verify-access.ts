import { LAUNCH_RESOURCE_TYPES, typeQuery } from "../../backend/src/resource-graph.js";
import {
  AzureAccessDeniedError,
  AzureAuthError,
  MetricUnavailableError,
  liveBudgetClient,
  liveCostClient,
  liveMetricsClient,
} from "../../backend/src/azure-live.js";
import { accessTokenClaims, FederatedExchangeError } from "../../backend/src/azure-federated.js";
import { liveHierarchyClient, liveProtectedItems, liveResourceGraphClient } from "../../backend/src/azure-live-graph.js";
import { MissingCostRoleError } from "../../backend/src/cost.js";
import { MissingMonitoringRoleError, METRIC_RESOURCE_TYPES, METRIC_WINDOW } from "../../backend/src/metrics.js";
import { ResourceGraphThrottleError } from "../../backend/src/resource-graph.js";
import { missingRoles } from "../../backend/src/cli-credentials.js";
import { aliasIds, liveRunDate, liveWiring, nowOf, out, runIfMain, startRun, writeRecord, type RunIo } from "./lib.js";

/**
 * #41 every role and query with read-only roles, and #42 cross-tenant federated access.
 * Writes docs/azure/live-runs/<date>-access.json. Not a check verification: the support
 * matrix ignores this record.
 */
export type Outcome = "ok" | "denied" | "auth-rejected" | "throttled" | "unavailable" | "failed" | "no-resource" | "not-built";

export type QueryResult = { name: string; role: string; outcome: Outcome; rows?: number };

export function outcomeOf(error: unknown): Outcome {
  if (error instanceof AzureAccessDeniedError || error instanceof MissingCostRoleError || error instanceof MissingMonitoringRoleError) {
    return "denied";
  }
  if (error instanceof AzureAuthError) {
    return "auth-rejected";
  }
  if (error instanceof ResourceGraphThrottleError) {
    return "throttled";
  }
  if (error instanceof MetricUnavailableError) {
    return "unavailable";
  }
  return "failed";
}

async function attempt(name: string, role: string, run: () => Promise<number | undefined>): Promise<QueryResult> {
  try {
    const rows = await run();
    return { name, role, outcome: "ok", ...(rows === undefined ? {} : { rows }) };
  } catch (error) {
    return { name, role, outcome: outcomeOf(error) };
  }
}

export async function main(_argv: string[] = [], io: RunIo = {}): Promise<number> {
  const runEnv = startRun(io);
  if (runEnv === "refused") {
    return 1;
  }
  if (!runEnv) {
    return 0;
  }
  const startedAt = nowOf(io);
  const { arm, wiring } = liveWiring(runEnv, io);
  const main = runEnv.subscriptions.main;
  const federated: Record<string, unknown> = { secretless: true, exchanged: false, tokenTenantMatches: null, crossTenant: null, error: null };
  let token: string | null = null;
  try {
    token = await arm.token();
    const { tid } = accessTokenClaims(token);
    federated.exchanged = true;
    federated.tokenTenantMatches = tid !== null && tid.toLowerCase() === runEnv.tenantId.toLowerCase();
    if (runEnv.homeTenantId) {
      federated.crossTenant = tid !== null && tid.toLowerCase() !== runEnv.homeTenantId.toLowerCase();
    } else {
      federated.crossTenantNote = "FARSIDE_AZURE_HOME_TENANT_ID not set; cross-tenant not proven";
    }
  } catch (error) {
    federated.error = error instanceof FederatedExchangeError ? `HTTP ${error.status} ${error.code ?? ""}`.trim() : "exchange failed";
  }

  const queries: QueryResult[] = [];
  let roles: Record<string, unknown> = { granted: [], missing: [], error: "not run: no token" };
  if (token) {
    try {
      const granted = await wiring.roleLister.list({ tenantId: runEnv.tenantId, subscriptionId: main, cloud: "azure" });
      roles = { granted, missing: missingRoles("azure", granted), error: null };
    } catch (error) {
      roles = { granted: [], missing: [], error: outcomeOf(error) };
    }
    const graph = liveResourceGraphClient(arm);
    let metricTarget: string | null = null;
    for (const type of LAUNCH_RESOURCE_TYPES) {
      queries.push(
        await attempt(`resource-graph ${type}`, "Reader", async () => {
          const page = await graph.query({ subscriptionId: main, query: typeQuery(type) });
          if (!metricTarget && (METRIC_RESOURCE_TYPES as readonly string[]).includes(type)) {
            metricTarget = page.data[0]?.id ?? null;
          }
          return page.data.length;
        }),
      );
    }
    const hierarchy = liveHierarchyClient(arm);
    queries.push(await attempt("management groups", "Reader", async () => (await hierarchy.listManagementGroups()).length));
    queries.push(await attempt("subscriptions", "Reader", async () => (await hierarchy.listSubscriptions()).length));
    queries.push(await attempt("backup protected items", "Backup Reader", async () => (await liveProtectedItems(arm, main)).size));
    const target: string | null = metricTarget;
    queries.push(
      target
        ? await attempt("monitor ByteCount", "Monitoring Reader", async () => {
            await liveMetricsClient(arm).query({ subscriptionId: main, resourceUri: target, metricName: "ByteCount", window: METRIC_WINDOW });
            return undefined;
          })
        : { name: "monitor ByteCount", role: "Monitoring Reader", outcome: "no-resource" },
    );
    queries.push(
      await attempt("cost management query", "Cost Management Reader", async () => {
        const page = await liveCostClient(arm).query({ billingScope: `/subscriptions/${main}` });
        return page.rows.length;
      }),
    );
    queries.push(
      await attempt("budgets", "Cost Management Reader", async () => {
        const [row] = await liveBudgetClient({ ...arm, subscriptionIds: [main] }).list();
        if (!row?.readable) {
          throw new AzureAccessDeniedError(403);
        }
        return row.budgetCount;
      }),
    );
    queries.push({ name: "reservations and savings plans", role: "Reservations Reader", outcome: "not-built" });
  }

  const record = {
    kind: "access",
    liveRunAt: liveRunDate(startedAt),
    startedAt: startedAt.toISOString(),
    issues: [41, 42],
    subscription: "main",
    federated,
    roles,
    queries,
  };
  const path = writeRecord(io, JSON.parse(aliasIds(runEnv, JSON.stringify(record))) as typeof record);
  out(io, `wrote ${path}`);
  const failed = queries.filter((query) => query.outcome !== "ok").map((query) => `${query.name}: ${query.outcome}`);
  out(io, federated.exchanged ? `federated exchange ok; ${failed.length} queries not ok` : `federated exchange failed: ${String(federated.error)}`);
  for (const line of failed) {
    out(io, `  ${line}`);
  }
  return federated.exchanged ? 0 : 1;
}

await runIfMain(import.meta.url, (argv) => main(argv));
