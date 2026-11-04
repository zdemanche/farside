import { MissingCostRoleError, type CostQueryClient, type CostQueryRow } from "./cost.js";
import type { BudgetClient, BudgetDefinition } from "./budgets.js";
import { MissingMonitoringRoleError, type MetricAggregate, type MetricsClient } from "./metrics.js";

/**
 * Read-only Azure Resource Manager clients. Request and response shapes follow Microsoft's
 * public REST reference and have NOT been run against a live subscription: every use must be
 * treated as unverified until a dated run record exists (docs/support-matrix.md).
 *
 * The bearer token comes from an injected function and is sent only to ARM_ORIGIN.
 */
export const ARM_ORIGIN = "https://management.azure.com";

export type TokenProvider = () => Promise<string>;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ArmOptions = {
  token: TokenProvider;
  fetch?: FetchLike;
  now?: () => Date;
};

export class AzureAccessDeniedError extends Error {
  constructor(readonly status: number) {
    super(`Azure refused the read (HTTP ${status})`);
    this.name = "AzureAccessDeniedError";
  }
}

export class AzureApiError extends Error {
  constructor(readonly status: number) {
    super(`Azure returned HTTP ${status}`);
    this.name = "AzureApiError";
  }
}

export class MetricUnavailableError extends Error {
  constructor() {
    super("Azure returned no metric data for the window");
    this.name = "MetricUnavailableError";
  }
}

function isArmUrl(url: string): boolean {
  return url.startsWith(`${ARM_ORIGIN}/`);
}

function safeArmPath(path: string): string {
  if (!path.startsWith("/subscriptions/") || /[?#]|\.\./.test(path)) {
    throw new Error("not an Azure resource path");
  }
  return path;
}

async function armJson(
  options: ArmOptions,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<unknown> {
  if (!isArmUrl(url)) {
    throw new Error("refusing to send credentials outside Azure Resource Manager");
  }
  const call = options.fetch ?? ((input, init) => fetch(input, init));
  const response = await call(url, {
    method,
    headers: {
      authorization: `Bearer ${await options.token()}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AzureAccessDeniedError(response.status);
  }
  if (!response.ok) {
    throw new AzureApiError(response.status);
  }
  return response.json();
}

type MetricsBody = { value?: Array<{ timeseries?: Array<{ data?: Array<{ total?: number }> }> }> };

export function liveMetricsClient(options: ArmOptions): MetricsClient {
  return {
    async query(input): Promise<MetricAggregate> {
      const days = Number(/^(\d+)d$/.exec(input.window)?.[1]);
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        throw new Error("metric window must be 1d to 30d");
      }
      const end = (options.now ?? (() => new Date()))();
      const start = new Date(end.getTime() - days * 86_400_000);
      const query = new URLSearchParams({
        "api-version": "2018-01-01",
        metricnames: input.metricName,
        aggregation: "Total",
        interval: "P1D",
        timespan: `${start.toISOString()}/${end.toISOString()}`,
      });
      const url = `${ARM_ORIGIN}${safeArmPath(input.resourceUri)}/providers/microsoft.insights/metrics?${query}`;
      let body: MetricsBody;
      try {
        body = (await armJson(options, "GET", url)) as MetricsBody;
      } catch (error) {
        if (error instanceof AzureAccessDeniedError) {
          throw new MissingMonitoringRoleError();
        }
        throw error;
      }
      const points = body.value?.[0]?.timeseries?.[0]?.data ?? [];
      const totals = points.map((point) => point.total).filter((total) => typeof total === "number");
      // No data points means the metric was not reported, not that traffic was zero.
      if (totals.length === 0) {
        throw new MetricUnavailableError();
      }
      return {
        resourceUri: input.resourceUri,
        metricName: "ByteCount",
        window: input.window,
        aggregation: "Total",
        value: totals.reduce((sum, total) => sum + total, 0),
      };
    },
  };
}

type CostBody = {
  properties?: {
    columns?: Array<{ name: string }>;
    rows?: Array<Array<string | number>>;
    nextLink?: string | null;
  };
};

function isoDate(usageDate: string | number): string {
  const text = String(usageDate);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
}

/** Three whole months back to today, so the harvest sees two complete months. */
function costWindow(now: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  return { from: from.toISOString(), to: now.toISOString() };
}

export function liveCostClient(options: ArmOptions): CostQueryClient {
  return {
    async query(input) {
      let body: CostBody;
      try {
        if (input.page) {
          body = (await armJson(options, "POST", input.page, costRequest(options))) as CostBody;
        } else {
          const url = `${ARM_ORIGIN}${safeArmPath(input.billingScope)}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`;
          body = (await armJson(options, "POST", url, costRequest(options))) as CostBody;
        }
      } catch (error) {
        if (error instanceof AzureAccessDeniedError) {
          throw new MissingCostRoleError();
        }
        throw error;
      }
      const columns = (body.properties?.columns ?? []).map((column) => column.name);
      const at = (name: string) => columns.indexOf(name);
      const [cost, date, service, currency] = [at("Cost"), at("UsageDate"), at("ServiceName"), at("Currency")];
      if ([cost, date, service, currency].includes(-1)) {
        throw new AzureApiError(502);
      }
      const rows: CostQueryRow[] = (body.properties?.rows ?? []).map((row) => ({
        date: isoDate(row[date] as string | number),
        serviceName: String(row[service]),
        costAmount: Number(row[cost]).toFixed(2),
        currency: String(row[currency]),
      }));
      const next = body.properties?.nextLink;
      return next ? { rows, nextPage: next } : { rows };
    },
  };
}

function costRequest(options: ArmOptions) {
  const { from, to } = costWindow((options.now ?? (() => new Date()))());
  return {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from, to },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [{ type: "Dimension", name: "ServiceName" }],
    },
  };
}

type BudgetsBody = { value?: Array<{ name?: string }> };

/** A subscription the token cannot read is reported unreadable, never as having no budget. */
export function liveBudgetClient(options: ArmOptions & { subscriptionIds: string[] }): BudgetClient {
  return {
    async list(): Promise<BudgetDefinition[]> {
      const definitions: BudgetDefinition[] = [];
      for (const subscriptionId of options.subscriptionIds) {
        const url = `${ARM_ORIGIN}${safeArmPath(`/subscriptions/${subscriptionId}`)}/providers/Microsoft.Consumption/budgets?api-version=2023-05-01`;
        try {
          const body = (await armJson(options, "GET", url)) as BudgetsBody;
          const names = (body.value ?? []).flatMap((budget) => (budget.name ? [budget.name] : []));
          definitions.push({ subscriptionId, budgetCount: names.length, budgetNames: names, readable: true });
        } catch (error) {
          if (!(error instanceof AzureAccessDeniedError)) {
            throw error;
          }
          definitions.push({ subscriptionId, budgetCount: 0, budgetNames: [], readable: false });
        }
      }
      return definitions;
    },
  };
}
