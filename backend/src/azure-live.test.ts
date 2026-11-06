import { describe, expect, it, vi } from "vitest";
import {
  ARM_ORIGIN,
  AzureApiError,
  AzureAccessDeniedError,
  AzureAuthError,
  MAX_ATTEMPTS,
  MetricUnavailableError,
  liveBudgetClient,
  liveCostClient,
  liveMetricsClient,
  type FetchLike,
} from "./azure-live.js";
import { MissingCostRoleError, harvestCost, readAllCostPages } from "./cost.js";
import { MissingMonitoringRoleError } from "./metrics.js";
import { checkNoBudgets } from "./budgets.js";

const NOW = () => new Date("2026-11-04T10:00:00.000Z");
const token = async () => "tok";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urlOf = (fetch: ReturnType<typeof vi.fn>, call = 0) => String(fetch.mock.calls[call]?.[0]);
const LB = "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Network/loadBalancers/lb1";

describe("live metrics client", () => {
  it("sums daily totals for the window and sends the token only to ARM", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      json({ value: [{ timeseries: [{ data: [{ total: 10 }, { total: 5 }, {}] }] }] }),
    );
    const out = await liveMetricsClient({ token, fetch, now: NOW }).query({
      subscriptionId: "s1",
      resourceUri: LB,
      metricName: "ByteCount",
      window: "7d",
    });
    expect(out.value).toBe(15);
    const url = urlOf(fetch);
    expect(url.startsWith(`${ARM_ORIGIN}${LB}/providers/microsoft.insights/metrics?`)).toBe(true);
    expect(url).toContain("timespan=2026-10-28T10%3A00%3A00.000Z%2F2026-11-04T10%3A00%3A00.000Z");
    expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
  });

  it("treats missing data as unavailable, never as zero traffic", async () => {
    const fetch = vi.fn<FetchLike>(async () => json({ value: [{ timeseries: [] }] }));
    await expect(
      liveMetricsClient({ token, fetch, now: NOW }).query({
        subscriptionId: "s1",
        resourceUri: LB,
        metricName: "ByteCount",
        window: "7d",
      }),
    ).rejects.toBeInstanceOf(MetricUnavailableError);
  });

  it("maps a refused read to the missing Monitoring Reader role", async () => {
    const fetch = vi.fn<FetchLike>(async () => json({}, 403));
    await expect(
      liveMetricsClient({ token, fetch, now: NOW }).query({
        subscriptionId: "s1",
        resourceUri: LB,
        metricName: "ByteCount",
        window: "7d",
      }),
    ).rejects.toBeInstanceOf(MissingMonitoringRoleError);
  });

  it("rejects resource paths that could leave the subscription path or add a query", async () => {
    const fetch = vi.fn<FetchLike>();
    const client = liveMetricsClient({ token, fetch, now: NOW });
    for (const resourceUri of [
      "https://evil.example/x",
      "/subscriptions/s1/../x",
      "/subscriptions/s1/x?a=b",
    ]) {
      await expect(
        client.query({ subscriptionId: "s1", resourceUri, metricName: "ByteCount", window: "7d" }),
      ).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("live cost client", () => {
  const page = (rows: Array<Array<string | number>>, nextLink?: string) =>
    json({
      properties: {
        columns: [
          { name: "Cost" },
          { name: "UsageDate" },
          { name: "ServiceName" },
          { name: "Currency" },
        ],
        rows,
        nextLink: nextLink ?? null,
      },
    });

  it("reads columns by name, follows nextLink with POST and feeds the harvest", async () => {
    const fetch = vi.fn<FetchLike>(async (url, init) =>
      init.method === "POST" && String(url).includes("skip=1")
        ? page([[2, 20260915, "Storage", "USD"]])
        : page([[1.5, 20260915, "Compute", "USD"]], `${ARM_ORIGIN}/q?skip=1`),
    );
    const client = liveCostClient({ token, fetch, now: NOW });
    const rows = await readAllCostPages(client, "/subscriptions/s1");
    expect(rows).toEqual([
      { date: "2026-09-15", serviceName: "Compute", costAmount: "1.50", currency: "USD" },
      { date: "2026-09-15", serviceName: "Storage", costAmount: "2.00", currency: "USD" },
    ]);
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "POST"]);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.timePeriod.from).toBe("2026-08-01T00:00:00.000Z");
    const result = await harvestCost({
      client,
      subscriptionId: "s1",
      billingScope: "/subscriptions/s1",
      agreementType: "unknown",
    });
    expect(result.ok).toBe(true);
  });

  it("never sends the token to a nextLink outside ARM", async () => {
    const fetch = vi.fn<FetchLike>(async () => page([], "https://evil.example/next"));
    const client = liveCostClient({ token, fetch, now: NOW });
    const first = await client.query({ billingScope: "/subscriptions/s1" });
    await expect(
      client.query({ billingScope: "/subscriptions/s1", page: first.nextPage }),
    ).rejects.toThrow(/outside Azure Resource Manager/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a refused read to the missing Cost Management Reader role", async () => {
    const fetch = vi.fn<FetchLike>(async () => json({}, 403));
    await expect(
      liveCostClient({ token, fetch, now: NOW }).query({ billingScope: "/subscriptions/s1" }),
    ).rejects.toBeInstanceOf(MissingCostRoleError);
  });

  it("fails loudly when the response has no expected columns", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      json({ properties: { columns: [{ name: "Other" }], rows: [] } }),
    );
    await expect(
      liveCostClient({ token, fetch, now: NOW }).query({ billingScope: "/subscriptions/s1" }),
    ).rejects.toBeInstanceOf(AzureApiError);
  });
});

describe("live budget client", () => {
  it("lists budget names per subscription and marks an unreadable one unreadable", async () => {
    const fetch = vi.fn<FetchLike>(async (url) =>
      String(url).includes("/subscriptions/s1/")
        ? json({ value: [{ name: "monthly" }] })
        : json({}, 403),
    );
    const defs = await liveBudgetClient({ token, fetch, subscriptionIds: ["s1", "s2"] }).list();
    expect(defs).toEqual([
      { subscriptionId: "s1", budgetCount: 1, budgetNames: ["monthly"], readable: true },
      { subscriptionId: "s2", budgetCount: 0, budgetNames: [], readable: false },
    ]);
    // An unreadable subscription is not reported as lacking a budget.
    const findings = checkNoBudgets(defs, "2026-11-04T00:00:00.000Z");
    expect(findings.find((f) => f.scope.subscriptionOrProject === "s2")?.result).not.toBe("fail");
  });

  it("does not hide an API failure as an empty list", async () => {
    const fetch = vi.fn<FetchLike>(async () => json({}, 500));
    await expect(
      liveBudgetClient({ token, fetch, subscriptionIds: ["s1"] }).list(),
    ).rejects.toBeInstanceOf(AzureApiError);
  });
});

describe("request safety", () => {
  const query = {
    subscriptionId: "s1",
    resourceUri: LB,
    metricName: "ByteCount",
    window: "7d",
  } as const;
  const okMetrics = () => json({ value: [{ timeseries: [{ data: [{ total: 1 }] }] }] });

  it("refuses redirects and sets a timeout on every call", async () => {
    const fetch = vi.fn<FetchLike>(async () => okMetrics());
    await liveMetricsClient({ token, fetch, now: NOW }).query(query);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never asks for the token when the URL is refused, including a lookalike host", async () => {
    const getToken = vi.fn(token);
    const fetch = vi.fn<FetchLike>(async () =>
      json({
        properties: {
          columns: [
            { name: "Cost" },
            { name: "UsageDate" },
            { name: "ServiceName" },
            { name: "Currency" },
          ],
          rows: [],
          nextLink: "https://management.azure.com.evil.example/x",
        },
      }),
    );
    const client = liveCostClient({ token: getToken, fetch, now: NOW });
    const first = await client.query({ billingScope: "/subscriptions/s1" });
    getToken.mockClear();
    await expect(
      client.query({ billingScope: "/subscriptions/s1", page: first.nextPage }),
    ).rejects.toThrow(/outside Azure/);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("allows only plain resource paths, and only inside the requested subscription", async () => {
    const fetch = vi.fn<FetchLike>();
    const client = liveMetricsClient({ token, fetch, now: NOW });
    for (const resourceUri of [
      "/subscriptions/s1/%2e%2e/x",
      "/subscriptions/s1//x",
      "/subscriptions/s1\\x",
      "/subscriptions/s1/a b",
      "/subscriptions/other/resourceGroups/rg/providers/Microsoft.Network/loadBalancers/lb1",
    ]) {
      await expect(client.query({ ...query, resourceUri })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds the metric window to 1d-30d", async () => {
    const fetch = vi.fn<FetchLike>(async () => okMetrics());
    const client = liveMetricsClient({ token, fetch, now: NOW });
    for (const window of ["0d", "31d", "7h", "d"]) {
      await expect(client.query({ ...query, window })).rejects.toThrow(/1d to 30d/);
    }
    await expect(client.query({ ...query, window: "30d" })).resolves.toMatchObject({ value: 1 });
  });

  it("tells an expired token (401) apart from a missing role (403)", async () => {
    const denied = vi.fn<FetchLike>(async () => json({}, 401));
    await expect(
      liveCostClient({ token, fetch: denied, now: NOW }).query({
        billingScope: "/subscriptions/s1",
      }),
    ).rejects.toBeInstanceOf(AzureAuthError);
    const budget = await liveBudgetClient({
      token,
      fetch: vi.fn<FetchLike>(async () => json({}, 403)),
      subscriptionIds: ["s1"],
    }).list();
    expect(budget[0]?.readable).toBe(false);
    await expect(
      liveBudgetClient({ token, fetch: denied, subscriptionIds: ["s1"] }).list(),
    ).rejects.toBeInstanceOf(AzureAuthError);
    expect(new AzureAccessDeniedError(403)).not.toBeInstanceOf(AzureAuthError);
  });

  it("retries a throttled read, waiting as Azure asks, and gives up after the limit", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const flaky = vi.fn<FetchLike>(async () =>
      (calls += 1) < 3
        ? new Response("{}", { status: 429, headers: { "retry-after": "2" } })
        : okMetrics(),
    );
    await liveMetricsClient({ token, fetch: flaky, now: NOW, sleep }).query(query);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([2000, 2000]);
    const stuck = vi.fn<FetchLike>(async () => json({}, 429));
    await expect(
      liveMetricsClient({ token, fetch: stuck, now: NOW, sleep }).query(query),
    ).rejects.toBeInstanceOf(AzureApiError);
    expect(stuck).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("rejects a malformed or missing cost instead of recording NaN or zero", async () => {
    const columns = [
      { name: "Cost" },
      { name: "UsageDate" },
      { name: "ServiceName" },
      { name: "Currency" },
    ];
    for (const cell of [null, "12", Number.NaN]) {
      const fetch = vi.fn<FetchLike>(async () =>
        json({ properties: { columns, rows: [[cell, 20260915, "Compute", "USD"]] } }),
      );
      await expect(
        liveCostClient({ token, fetch, now: NOW }).query({ billingScope: "/subscriptions/s1" }),
      ).rejects.toBeInstanceOf(AzureApiError);
    }
    const notRows = vi.fn<FetchLike>(async () => json({ properties: { columns, rows: "nope" } }));
    await expect(
      liveCostClient({ token, fetch: notRows, now: NOW }).query({
        billingScope: "/subscriptions/s1",
      }),
    ).rejects.toBeInstanceOf(AzureApiError);
  });

  it("sends the same query window with every page of one harvest", async () => {
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 10, 4, 10, tick++));
    const columns = [
      { name: "Cost" },
      { name: "UsageDate" },
      { name: "ServiceName" },
      { name: "Currency" },
    ];
    const fetch = vi.fn<FetchLike>(async (_url, init) =>
      json({
        properties: {
          columns,
          rows: [],
          nextLink: init.body && fetch.mock.calls.length < 2 ? `${ARM_ORIGIN}/next` : null,
        },
      }),
    );
    await readAllCostPages(liveCostClient({ token, fetch, now }), "/subscriptions/s1");
    const bodies = fetch.mock.calls.map((call) => String(call[1]?.body));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("follows the budgets next page, and marks only an unsupported subscription unreadable", async () => {
    const fetch = vi.fn<FetchLike>(async (url) => {
      const text = String(url);
      if (text.includes("/subscriptions/s2/")) return json({}, 404);
      return text.includes("page2")
        ? json({ value: [{ name: "b2" }] })
        : json({ value: [{ name: "b1" }], nextLink: `${ARM_ORIGIN}/page2` });
    });
    const defs = await liveBudgetClient({
      token,
      fetch,
      subscriptionIds: ["s1", "s2", "s3"],
    }).list();
    expect(defs.map((d) => [d.subscriptionId, d.readable, d.budgetNames])).toEqual([
      ["s1", true, ["b1", "b2"]],
      ["s2", false, []],
      ["s3", true, ["b1", "b2"]],
    ]);
  });

  it("rejects a subscription id that could add path segments", async () => {
    const fetch = vi.fn<FetchLike>();
    await expect(
      liveBudgetClient({ token, fetch, subscriptionIds: ["s1/x"] }).list(),
    ).rejects.toThrow(/not a subscription id/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
