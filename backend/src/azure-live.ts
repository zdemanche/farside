import { MissingCostRoleError, type CostQueryClient, type CostQueryRow } from "./cost.js";
import type { BudgetClient, BudgetDefinition } from "./budgets.js";
import { MissingMonitoringRoleError, type MetricAggregate, type MetricsClient } from "./metrics.js";
import { subscriptionOf } from "./providers/arm.js";

/**
 * Read-only Azure Resource Manager clients. Request and response shapes follow Microsoft's
 * public REST reference and have NOT been run against a live subscription: every use must be
 * treated as unverified until a dated run record exists (docs/support-matrix.md).
 *
 * The bearer token comes from an injected function and is sent only to ARM_ORIGIN.
 */
export const ARM_ORIGIN = "https://management.azure.com";
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const MAX_RETRY_WAIT_MS = 5_000;
const MAX_PAGES = 50;

export type TokenProvider = () => Promise<string>;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ArmOptions = {
  /** Called once per request, so it should cache. */
  token: TokenProvider;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

/** HTTP 403: the identity lacks a role. */
export class AzureAccessDeniedError extends Error {
  constructor(readonly status: number) {
    super(`Azure refused the read (HTTP ${status})`);
    this.name = "AzureAccessDeniedError";
  }
}

/** HTTP 401: the token is missing, expired or invalid. Not a missing role. */
export class AzureAuthError extends Error {
  constructor() {
    super("Azure rejected the access token (HTTP 401)");
    this.name = "AzureAuthError";
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

const SUBSCRIPTION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// Only plain resource-path segments: no encoded dots, slashes, backslashes or whitespace.
const ARM_PATH = /^\/subscriptions\/[A-Za-z0-9][A-Za-z0-9-]{0,63}(\/[A-Za-z0-9._()-]+)*$/;

function isArmUrl(url: string): boolean {
  return url.startsWith(`${ARM_ORIGIN}/`);
}

function safeArmPath(path: string): string {
  if (!ARM_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("not an Azure resource path");
  }
  return path;
}

function clock(options: ArmOptions): Date {
  return (options.now ?? (() => new Date()))();
}

async function pause(options: ArmOptions, ms: number): Promise<void> {
  await (options.sleep ?? ((wait: number) => new Promise<void>((resolve) => setTimeout(resolve, wait))))(ms);
}

function retryWait(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  const seconds = Number.isFinite(header) && header > 0 ? header * 1000 : 500 * 2 ** attempt;
  return Math.min(seconds, MAX_RETRY_WAIT_MS);
}

async function armJson(
  options: ArmOptions,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<unknown> {
  // Checked before the token is requested, so a refused URL never touches the credential.
  if (!isArmUrl(url)) {
    throw new Error("refusing to send credentials outside Azure Resource Manager");
  }
  const call = options.fetch ?? ((input, init) => fetch(input, init));
  for (let attempt = 0; ; attempt += 1) {
    const response = await call(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${await options.token()}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      throw new AzureAuthError();
    }
    if (response.status === 403) {
      throw new AzureAccessDeniedError(response.status);
    }
    const throttled = response.status === 429 || response.status === 503;
    if (throttled && attempt + 1 < MAX_ATTEMPTS) {
      await pause(options, retryWait(response, attempt));
      continue;
    }
    if (!response.ok) {
      throw new AzureApiError(response.status);
    }
    return response.json();
  }
}

type MetricsBody = { value?: Array<{ timeseries?: Array<{ data?: Array<{ total?: number }> }> }> };

export function liveMetricsClient(options: ArmOptions): MetricsClient {
  return {
    async query(input): Promise<MetricAggregate> {
      const days = Number(/^(\d+)d$/.exec(input.window)?.[1]);
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        throw new Error("metric window must be 1d to 30d");
      }
      const path = safeArmPath(input.resourceUri);
      if (subscriptionOf(path).toLowerCase() !== input.subscriptionId.toLowerCase()) {
        throw new Error("resource is not in the requested subscription");
      }
      const end = clock(options);
      const start = new Date(end.getTime() - days * 86_400_000);
      const query = new URLSearchParams({
        "api-version": "2018-01-01",
        metricnames: input.metricName,
        aggregation: "Total",
        interval: "P1D",
        timespan: `${start.toISOString()}/${end.toISOString()}`,
      });
      const url = `${ARM_ORIGIN}${path}/providers/microsoft.insights/metrics?${query}`;
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
      const totals = points
        .map((point) => point.total)
        .filter((total): total is number => typeof total === "number" && Number.isFinite(total));
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
    rows?: unknown;
    nextLink?: string | null;
  };
};

function isoDate(usageDate: string | number): string {
  const text = String(usageDate);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
}

/** Three whole months back to now, so the harvest sees three complete months. */
function costRequest(now: Date) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  return {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from: from.toISOString(), to: now.toISOString() },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [{ type: "Dimension", name: "ServiceName" }],
    },
  };
}

/** The query window is fixed when the client is made, so every page of a harvest uses the same one. */
export function liveCostClient(options: ArmOptions): CostQueryClient {
  const request = costRequest(clock(options));
  return {
    async query(input) {
      const url = input.page
        ? input.page
        : `${ARM_ORIGIN}${safeArmPath(input.billingScope)}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`;
      let body: CostBody;
      try {
        body = (await armJson(options, "POST", url, request)) as CostBody;
      } catch (error) {
        if (error instanceof AzureAccessDeniedError) {
          throw new MissingCostRoleError();
        }
        throw error;
      }
      const columns = (body.properties?.columns ?? []).map((column) => column.name);
      const [cost, date, service, currency] = ["Cost", "UsageDate", "ServiceName", "Currency"].map((name) =>
        columns.indexOf(name),
      ) as [number, number, number, number];
      const raw = body.properties?.rows;
      if ([cost, date, service, currency].includes(-1) || !Array.isArray(raw)) {
        throw new AzureApiError(502);
      }
      const rows: CostQueryRow[] = raw.map((row: unknown) => {
        if (!Array.isArray(row)) {
          throw new AzureApiError(502);
        }
        const amount = row[cost];
        // A missing or non-numeric cost must not become 0.00 or NaN in the books.
        if (typeof amount !== "number" || !Number.isFinite(amount)) {
          throw new AzureApiError(502);
        }
        return {
          date: isoDate(row[date] as string | number),
          serviceName: String(row[service]),
          costAmount: amount.toFixed(2),
          currency: String(row[currency]),
        };
      });
      const next = body.properties?.nextLink;
      return next ? { rows, nextPage: next } : { rows };
    },
  };
}

type BudgetsBody = { value?: Array<{ name?: string }>; nextLink?: string | null };

async function budgetNames(options: ArmOptions, subscriptionId: string): Promise<string[]> {
  const names: string[] = [];
  let url: string | undefined =
    `${ARM_ORIGIN}${safeArmPath(`/subscriptions/${subscriptionId}`)}/providers/Microsoft.Consumption/budgets?api-version=2023-05-01`;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const body = (await armJson(options, "GET", url)) as BudgetsBody;
    names.push(...(body.value ?? []).flatMap((budget) => (budget.name ? [budget.name] : [])));
    url = body.nextLink ?? undefined;
  }
  if (url) {
    throw new Error("budgets list exceeded page limit");
  }
  return names;
}

/**
 * A subscription the token cannot read, or whose offer has no budgets API (HTTP 400/404), is
 * reported unreadable, never as having no budget. Any other failure stops the list.
 */
export function liveBudgetClient(options: ArmOptions & { subscriptionIds: string[] }): BudgetClient {
  return {
    async list(): Promise<BudgetDefinition[]> {
      const definitions: BudgetDefinition[] = [];
      for (const subscriptionId of options.subscriptionIds) {
        if (!SUBSCRIPTION_ID.test(subscriptionId)) {
          throw new Error("not a subscription id");
        }
        try {
          const names = await budgetNames(options, subscriptionId);
          definitions.push({ subscriptionId, budgetCount: names.length, budgetNames: names, readable: true });
        } catch (error) {
          const unreadable =
            error instanceof AzureAccessDeniedError ||
            (error instanceof AzureApiError && (error.status === 400 || error.status === 404));
          if (!unreadable) {
            throw error;
          }
          definitions.push({ subscriptionId, budgetCount: 0, budgetNames: [], readable: false });
        }
      }
      return definitions;
    },
  };
}
