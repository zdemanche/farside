import { describe, expect, it, vi } from "vitest";
import {
  ARM_ORIGIN,
  AzureApiError,
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
    expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer tok");
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
    for (const resourceUri of ["https://evil.example/x", "/subscriptions/s1/../x", "/subscriptions/s1/x?a=b"]) {
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
        columns: [{ name: "Cost" }, { name: "UsageDate" }, { name: "ServiceName" }, { name: "Currency" }],
        rows,
        nextLink: nextLink ?? null,
      },
    });

  it("reads columns by name, follows nextLink with POST and feeds the harvest", async () => {
    const fetch = vi.fn<FetchLike>(async (_url, init) =>
      init.method === "POST" && String(_url).includes("skip=1")
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
    const result = await harvestCost({ client, subscriptionId: "s1", billingScope: "/subscriptions/s1", agreementType: "unknown" });
    expect(result.ok).toBe(true);
  });

  it("never sends the token to a nextLink outside ARM", async () => {
    const fetch = vi.fn<FetchLike>(async () => page([], "https://evil.example/next"));
    const client = liveCostClient({ token, fetch, now: NOW });
    const first = await client.query({ billingScope: "/subscriptions/s1" });
    await expect(client.query({ billingScope: "/subscriptions/s1", page: first.nextPage })).rejects.toThrow(
      /outside Azure Resource Manager/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a refused read to the missing Cost Management Reader role", async () => {
    const fetch = vi.fn<FetchLike>(async () => json({}, 403));
    await expect(liveCostClient({ token, fetch, now: NOW }).query({ billingScope: "/subscriptions/s1" })).rejects.toBeInstanceOf(
      MissingCostRoleError,
    );
  });

  it("fails loudly when the response has no expected columns", async () => {
    const fetch = vi.fn<FetchLike>(async () => json({ properties: { columns: [{ name: "Other" }], rows: [] } }));
    await expect(liveCostClient({ token, fetch, now: NOW }).query({ billingScope: "/subscriptions/s1" })).rejects.toBeInstanceOf(
      AzureApiError,
    );
  });
});

describe("live budget client", () => {
  it("lists budget names per subscription and marks an unreadable one unreadable", async () => {
    const fetch = vi.fn<FetchLike>(async (url) =>
      String(url).includes("/subscriptions/s1/") ? json({ value: [{ name: "monthly" }] }) : json({}, 403),
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
    await expect(liveBudgetClient({ token, fetch, subscriptionIds: ["s1"] }).list()).rejects.toBeInstanceOf(AzureApiError);
  });
});
