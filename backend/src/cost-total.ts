import { applyCoverageResults, type CoverageEntry, type CoverageResult } from "./coverage.js";
import {
  addAmounts,
  CURRENCY_CLOSER,
  MONTH_ON_MONTH,
  monthOnMonth,
  SPEND_BY_SERVICE,
  TWO_MONTHS_CLOSER,
  type CostFigure,
  type CostSnapshot,
} from "./cost.js";

export const MIXED_CURRENCY_CLOSER = CURRENCY_CLOSER;

const COST_CHECK_IDS = [SPEND_BY_SERVICE, MONTH_ON_MONTH];

export function hasFigures(snapshot: CostSnapshot): boolean {
  return snapshot.currency.length > 0 && snapshot.services.length + snapshot.months.length > 0;
}

export function hasMixedCurrencies(snapshots: readonly CostSnapshot[]): boolean {
  return (
    new Set(
      snapshots.filter(hasFigures).flatMap((snapshot) => [
        snapshot.currency,
        ...snapshot.services.map((figure) => figure.currency),
        ...snapshot.months.map((figure) => figure.currency),
      ]),
    ).size > 1
  );
}

function monthOf(figure: CostFigure): string {
  return figure.periodStart.slice(0, 7);
}

function sumMonthly(figures: readonly CostFigure[], scopes: string): CostFigure[] {
  const groups = new Map<string, CostFigure[]>();
  for (const figure of figures) {
    const key = `${figure.serviceName}|${monthOf(figure)}`;
    const group = groups.get(key);
    if (group) {
      group.push(figure);
    } else {
      groups.set(key, [figure]);
    }
  }
  return [...groups.values()]
    .flatMap((group) => {
      const first = group[0];
      if (!first) {
        return [];
      }
      return [
        {
          ...first,
          billingScope: scopes,
          agreementType: new Set(group.map((item) => item.agreementType)).size > 1 ? "mixed" : first.agreementType,
          periodEnd: group.map((item) => item.periodEnd).sort().at(-1) ?? first.periodEnd,
          costAmount: addAmounts(group.map((item) => item.costAmount)),
          provisional: group.some((item) => item.provisional),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.periodStart.localeCompare(right.periodStart) || left.serviceName.localeCompare(right.serviceName),
    );
}

export function combineCosts(snapshots: readonly CostSnapshot[]): CostSnapshot | null {
  const usable = snapshots.filter(hasFigures);
  const first = usable[0];
  if (!first || hasMixedCurrencies(usable)) {
    return null;
  }
  if (usable.length === 1) {
    return first;
  }
  const scopes = [...new Set(usable.map((snapshot) => snapshot.billingScope))].join(",");
  const agreementType =
    new Set(usable.map((snapshot) => snapshot.agreementType)).size > 1 ? "mixed" : first.agreementType;
  const months = sumMonthly(
    usable.flatMap((snapshot) => snapshot.months),
    scopes,
  );
  const services = sumMonthly(
    usable.flatMap((snapshot) => snapshot.services),
    scopes,
  );
  const serviceMonths = sumMonthly(
    usable.flatMap((snapshot) => snapshot.serviceMonths),
    scopes,
  );
  const provisional = usable.flatMap((snapshot) => (snapshot.provisionalDate ? [snapshot.provisionalDate] : []));
  return {
    ...first,
    subscriptionId: usable.map((snapshot) => snapshot.subscriptionId).join(","),
    billingScope: scopes,
    agreementType,
    periodStart: months[0]?.periodStart ?? first.periodStart,
    periodEnd: months.at(-1)?.periodEnd ?? first.periodEnd,
    asOf: usable.map((snapshot) => snapshot.asOf).sort().at(-1) ?? first.asOf,
    provisionalDate: provisional.sort().at(-1) ?? null,
    services,
    months,
    serviceMonths,
    monthOnMonth: monthOnMonth(serviceMonths, agreementType),
  };
}

export function markMixedCurrency(
  coverage: CoverageEntry[],
  subscriptionIds: readonly string[],
): CoverageEntry[] {
  if (subscriptionIds.length === 0) {
    return coverage;
  }
  return applyCoverageResults(
    coverage,
    subscriptionIds.flatMap((subscriptionOrProject) =>
      COST_CHECK_IDS.map((checkId): CoverageResult => ({
        subscriptionOrProject,
        checkId,
        state: "undetermined",
        closer: MIXED_CURRENCY_CLOSER,
      })),
    ),
  );
}

export function restoreAfterMixedCurrency(
  coverage: CoverageEntry[],
  snapshots: Record<string, CostSnapshot>,
): CoverageEntry[] {
  const restored = coverage
    .filter(
      (entry) =>
        COST_CHECK_IDS.includes(entry.checkId) &&
        entry.state === "undetermined" &&
        entry.closer === MIXED_CURRENCY_CLOSER &&
        snapshots[entry.subscriptionOrProject] !== undefined,
    )
    .map((entry): CoverageResult => {
      const hasChange = (snapshots[entry.subscriptionOrProject]?.monthOnMonth.length ?? 0) > 0;
      const unresolved = entry.checkId === MONTH_ON_MONTH && !hasChange;
      return {
        subscriptionOrProject: entry.subscriptionOrProject,
        checkId: entry.checkId,
        state: unresolved ? "undetermined" : "assessed",
        ...(unresolved ? { closer: TWO_MONTHS_CLOSER } : {}),
      };
    });
  return restored.length > 0 ? applyCoverageResults(coverage, restored) : coverage;
}
