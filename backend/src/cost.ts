import { applyCoverageResult, recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { rejectUnconfigured } from "./providers/unconfigured.js";
import docAzureCostQueryPages from "../../docs/azure/cost-query-pages.json" with { type: "json" };

export const SPEND_BY_SERVICE = "azure-cost-spend-by-service";
export const MONTH_ON_MONTH = "azure-cost-month-on-month";
export const COST_ROLE_CLOSER = "Cost Management Reader on the right billing scope";
export const TWO_MONTHS_CLOSER = "Two complete months of Cost Management data at that scope";
export const CURRENCY_CLOSER = "Cost Management rows in a single currency at that scope";

export type CostQueryRow = {
  date: string;
  serviceName: string;
  costAmount: string;
  currency: string;
};

export type CostQueryPage = {
  rows: CostQueryRow[];
  nextPage?: string;
};

export type CostQueryClient = {
  query: (input: { billingScope: string; page?: string }) => Promise<CostQueryPage>;
};

export type CostFigure = {
  billingScope: string;
  currency: string;
  agreementType: string;
  serviceName: string;
  periodStart: string;
  periodEnd: string;
  costAmount: string;
  provisional: boolean;
};

export type MonthChange = {
  billingScope: string;
  currency: string;
  agreementType: string;
  serviceName: string;
  currentMonth: string;
  previousMonth: string;
  currentMonthCost: string;
  previousMonthCost: string;
  deltaAmount: string;
  deltaPercent: string;
};

export type CostSnapshot = {
  subscriptionId: string;
  billingScope: string;
  currency: string;
  agreementType: string;
  periodStart: string;
  periodEnd: string;
  asOf: string;
  provisionalDate: string | null;
  services: CostFigure[];
  months: CostFigure[];
  serviceMonths: CostFigure[];
  monthOnMonth: MonthChange[];
};

export type CostHarvestResult =
  | { ok: true; snapshot: CostSnapshot; coverage: CoverageEntry[] }
  | { ok: false; reason: "missing_role" | "mixed_currency"; coverage: CoverageEntry[] };

export class CrossCurrencyError extends Error {
  constructor() {
    super("totals are never summed across currencies");
    this.name = "CrossCurrencyError";
  }
}

export class MissingCostRoleError extends Error {
  constructor() {
    super("Cost Management Reader is missing");
    this.name = "MissingCostRoleError";
  }
}

type PagesFile = {
  firstPage: string;
  pages: Record<string, CostQueryPage>;
};

const PAGES = docAzureCostQueryPages as PagesFile;

export function fixtureCostClient(pages: PagesFile = PAGES): CostQueryClient {
  return {
    async query(input) {
      const key = input.page ?? pages.firstPage;
      const page = pages.pages[key];
      if (!page) {
        return { rows: [] };
      }
      return page;
    },
  };
}

export function defaultCostClient(): CostQueryClient {
  return fixtureCostClient();
}

export function unconfiguredCostClient(): CostQueryClient {
  return {
    async query() {
      rejectUnconfigured();
    },
  };
}

export function missingCostRoleClient(): CostQueryClient {
  return {
    async query() {
      throw new MissingCostRoleError();
    },
  };
}

function toCents(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const frac2 = `${fraction}00`.slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(frac2);
  return negative ? -cents : cents;
}

function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function addAmounts(amounts: readonly string[]): string {
  return fromCents(amounts.reduce((sum, amount) => sum + toCents(amount), 0n));
}

export function totalSameCurrency(
  figures: readonly { costAmount: string; currency: string }[],
  currency: string,
): string {
  if (figures.some((figure) => figure.currency !== currency)) {
    throw new CrossCurrencyError();
  }
  return addAmounts(figures.map((figure) => figure.costAmount));
}

function yearMonth(date: string): string {
  return date.slice(0, 7);
}

function mixedCurrencyCoverage(subscriptionId: string): CoverageEntry[] {
  return [SPEND_BY_SERVICE, MONTH_ON_MONTH].map((checkId) =>
    recordCoverageScope({
      subscriptionOrProject: subscriptionId,
      checkId,
      state: "undetermined",
      closer: CURRENCY_CLOSER,
    }),
  );
}

function completeMonthRows(rows: CostQueryRow[]): CostQueryRow[] {
  const dates = rows.map((row) => row.date).sort();
  const first = dates[0];
  const last = dates.at(-1);
  // The query window is not known here, so the first row date stands in for it: a scope with $0 on the 1st reads as a partial month.
  const leadingPartial = first && !first.endsWith("-01") ? yearMonth(first) : null;
  const trailing = last ? yearMonth(last) : null;
  return rows.filter((row) => {
    const month = yearMonth(row.date);
    return month !== leadingPartial && month !== trailing;
  });
}

function missingRoleCoverage(subscriptionId: string): CoverageEntry[] {
  return [SPEND_BY_SERVICE, MONTH_ON_MONTH].map((checkId) =>
    recordCoverageScope({
      subscriptionOrProject: subscriptionId,
      checkId,
      state: "unassessed",
      causeId: "missing_role",
      closer: COST_ROLE_CLOSER,
    }),
  );
}

export async function readAllCostPages(
  client: CostQueryClient,
  billingScope: string,
): Promise<CostQueryRow[]> {
  const rows: CostQueryRow[] = [];
  let page: string | undefined;
  for (let safety = 0; safety < 50; safety += 1) {
    const result = await client.query(page ? { billingScope, page } : { billingScope });
    rows.push(...result.rows);
    if (!result.nextPage) {
      return rows;
    }
    page = result.nextPage;
  }
  throw new Error("cost query exceeded page limit");
}

export function monthOnMonth(
  figures: readonly CostFigure[],
  agreementType: string,
): MonthChange[] {
  const complete = figures.filter((figure) => !figure.provisional);
  const months = [...new Set(complete.map((figure) => yearMonth(figure.periodStart)))].sort();
  const currentMonth = months[months.length - 1];
  const previousMonth = months[months.length - 2];
  if (!currentMonth || !previousMonth) {
    return [];
  }
  const services = [...new Set(complete.map((figure) => figure.serviceName))].sort();
  return services.flatMap((serviceName) => {
    const current = complete.find(
      (figure) => figure.serviceName === serviceName && yearMonth(figure.periodStart) === currentMonth,
    );
    const previous = complete.find(
      (figure) => figure.serviceName === serviceName && yearMonth(figure.periodStart) === previousMonth,
    );
    if (!current || !previous) {
      return [];
    }
    if (current.currency !== previous.currency) {
      throw new CrossCurrencyError();
    }
    const delta = fromCents(toCents(current.costAmount) - toCents(previous.costAmount));
    const previousCents = toCents(previous.costAmount);
    const deltaPercent =
      previousCents === 0n
        ? "0.00"
        : ((Number(toCents(delta)) / Number(previousCents)) * 100).toFixed(2);
    return [
      {
        billingScope: current.billingScope,
        currency: current.currency,
        agreementType,
        serviceName,
        currentMonth,
        previousMonth,
        currentMonthCost: current.costAmount,
        previousMonthCost: previous.costAmount,
        deltaAmount: delta,
        deltaPercent,
      },
    ];
  });
}

export function figuresFromRows(
  rows: CostQueryRow[],
  input: { billingScope: string; agreementType: string },
): { services: CostFigure[]; months: CostFigure[]; provisionalDate: string | null } {
  if (rows.length === 0) {
    return { services: [], months: [], provisionalDate: null };
  }
  const dates = rows.map((row) => row.date).sort();
  const latest = dates[dates.length - 1] ?? null;
  const complete = completeMonthRows(rows);
  const monthKeys = [...new Set(complete.map((row) => yearMonth(row.date)))].sort();
  const latestComplete = monthKeys[monthKeys.length - 1];
  const services = [...new Set(complete.map((row) => row.serviceName))].sort();
  const serviceFigures = services.flatMap((serviceName) => {
    if (!latestComplete) {
      return [];
    }
    const monthRows = complete.filter(
      (row) => row.serviceName === serviceName && yearMonth(row.date) === latestComplete,
    );
    const first = monthRows[0];
    if (!first) {
      return [];
    }
    return [
      {
        billingScope: input.billingScope,
        currency: first.currency,
        agreementType: input.agreementType,
        serviceName,
        periodStart: `${latestComplete}-01`,
        periodEnd: monthRows.map((row) => row.date).sort().at(-1) ?? `${latestComplete}-01`,
        costAmount: totalSameCurrency(monthRows, first.currency),
        provisional: false,
      },
    ];
  });
  const monthFigures = monthKeys.flatMap((month) => {
    const monthRows = complete.filter((row) => yearMonth(row.date) === month);
    const first = monthRows[0];
    if (!first) {
      return [];
    }
    return [
      {
        billingScope: input.billingScope,
        currency: first.currency,
        agreementType: input.agreementType,
        serviceName: "all",
        periodStart: `${month}-01`,
        periodEnd: monthRows.map((row) => row.date).sort().at(-1) ?? `${month}-01`,
        costAmount: totalSameCurrency(monthRows, first.currency),
        provisional: false,
      },
    ];
  });
  return { services: serviceFigures, months: monthFigures, provisionalDate: latest };
}

export async function harvestCost(input: {
  client: CostQueryClient;
  subscriptionId: string;
  billingScope: string;
  agreementType: string;
  asOf?: string;
}): Promise<CostHarvestResult> {
  try {
    const rows = await readAllCostPages(input.client, input.billingScope);
    const figures = figuresFromRows(rows, {
      billingScope: input.billingScope,
      agreementType: input.agreementType,
    });
    const serviceMonths = monthlyServiceFigures(rows, input);
    const snapshot: CostSnapshot = {
      subscriptionId: input.subscriptionId,
      billingScope: input.billingScope,
      currency: rows[0]?.currency ?? "",
      agreementType: input.agreementType,
      periodStart: figures.months[0]?.periodStart ?? "",
      periodEnd: figures.months.at(-1)?.periodEnd ?? "",
      asOf: input.asOf ?? "1970-01-01T00:00:00.000Z",
      provisionalDate: figures.provisionalDate,
      services: figures.services,
      months: figures.months,
      serviceMonths,
      monthOnMonth: monthOnMonth(serviceMonths, input.agreementType),
    };
    const coverage = [
      recordCoverageScope({
        subscriptionOrProject: input.subscriptionId,
        checkId: SPEND_BY_SERVICE,
        state: "assessed",
      }),
      snapshot.monthOnMonth.length > 0
        ? recordCoverageScope({
            subscriptionOrProject: input.subscriptionId,
            checkId: MONTH_ON_MONTH,
            state: "assessed",
          })
        : recordCoverageScope({
            subscriptionOrProject: input.subscriptionId,
            checkId: MONTH_ON_MONTH,
            state: "undetermined",
            closer: TWO_MONTHS_CLOSER,
          }),
    ];
    return { ok: true, snapshot, coverage };
  } catch (error) {
    if (error instanceof MissingCostRoleError) {
      return { ok: false, reason: "missing_role", coverage: missingRoleCoverage(input.subscriptionId) };
    }
    if (error instanceof CrossCurrencyError) {
      return { ok: false, reason: "mixed_currency", coverage: mixedCurrencyCoverage(input.subscriptionId) };
    }
    throw error;
  }
}

export function applyCostCoverage(existing: CoverageEntry[], harvested: CoverageEntry[]): CoverageEntry[] {
  return harvested.reduce((coverage, entry) => applyCoverageResult(coverage, entry), existing);
}

function monthlyServiceFigures(
  rows: CostQueryRow[],
  input: { billingScope: string; agreementType: string },
): CostFigure[] {
  if (rows.length === 0) {
    return [];
  }
  const complete = completeMonthRows(rows);
  const keys = new Map<string, CostQueryRow[]>();
  for (const row of complete) {
    const key = `${yearMonth(row.date)}:${row.serviceName}`;
    const group = keys.get(key) ?? [];
    group.push(row);
    keys.set(key, group);
  }
  return [...keys.entries()].flatMap(([key, group]) => {
    const first = group[0];
    if (!first) {
      return [];
    }
    const month = key.split(":")[0] ?? yearMonth(first.date);
    return [
      {
        billingScope: input.billingScope,
        currency: first.currency,
        agreementType: input.agreementType,
        serviceName: first.serviceName,
        periodStart: `${month}-01`,
        periodEnd: group.map((row) => row.date).sort().at(-1) ?? `${month}-01`,
        costAmount: totalSameCurrency(group, first.currency),
        provisional: false,
      },
    ];
  });
}
