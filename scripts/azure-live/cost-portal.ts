import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { liveCostClient } from "../../backend/src/azure-live.js";
import { harvestCost } from "../../backend/src/cost.js";
import { ROOT, aliasIds, err, liveRunDate, liveWiring, nowOf, out, runIfMain, startRun, writeRecord, type RunIo } from "./lib.js";

/**
 * #131 portal comparison. Default: harvest live Cost Management totals for the main
 * subscription and write <date>-cost-totals.json with an empty `portal` value per row for a
 * person to copy from the Azure portal (Cost analysis, same scope, same months, actual cost).
 * `--compare <file>`: read that filled file (no Azure call) and write <date>-cost-portal.json,
 * whose spend-by-service and month-on-month results feed the support matrix.
 */
export const AGREEMENT_TYPES = [
  { label: "Pay-as-you-go", key: "payg" },
  { label: "Microsoft Customer Agreement", key: "MicrosoftCustomerAgreement" },
  { label: "Enterprise Agreement", key: "EnterpriseAgreement" },
  { label: "Cloud Solution Provider", key: "CSP" },
] as const;
export const TOLERANCE_PERCENT = 0.5;
const DECIMAL = /^-?\d+(\.\d+)?$/;

type Row = { harvested: string; portal: string | null };
type MonthRow = Row & { month: string };
type ServiceRow = Row & { serviceName: string; month: string };

export type CostTotals = {
  kind: "cost-totals";
  liveRunAt: string;
  startedAt: string;
  issues: number[];
  subscription: string;
  billingScope: string;
  currency: string;
  agreementType: string;
  tolerancePercent: number;
  instructions: string;
  months: MonthRow[];
  services: ServiceRow[];
  untestedAgreementTypes: string[];
};

export function untestedAgreementTypes(tested: string | null): string[] {
  return AGREEMENT_TYPES.filter((type) => type.key.toLowerCase() !== (tested ?? "").toLowerCase()).map((type) => type.label);
}

export function withinTolerance(harvested: string, portal: string, percent = TOLERANCE_PERCENT): boolean {
  const left = Number(harvested);
  const right = Number(portal);
  return Math.abs(left - right) <= Math.max(0.01, (Math.abs(right) * percent) / 100);
}

export function compareTotals(totals: CostTotals): { matched: boolean; problems: string[] } {
  const problems: string[] = [];
  const rows: Array<[string, Row]> = [
    ...totals.months.map((row) => [`month ${row.month}`, row] as [string, Row]),
    ...totals.services.map((row) => [`${row.serviceName} ${row.month}`, row] as [string, Row]),
  ];
  if (rows.length === 0) {
    problems.push("no harvested rows to compare");
  }
  for (const [label, row] of rows) {
    if (row.portal === null || !DECIMAL.test(row.portal)) {
      problems.push(`${label}: portal value missing or not a decimal`);
    } else if (!withinTolerance(row.harvested, row.portal, totals.tolerancePercent)) {
      problems.push(`${label}: harvested ${row.harvested} vs portal ${row.portal}`);
    }
  }
  if (totals.months.length < 2) {
    problems.push("month-on-month needs two complete months");
  }
  return { matched: problems.length === 0, problems };
}

async function harvest(io: RunIo): Promise<number> {
  const runEnv = startRun(io);
  if (runEnv === "refused") {
    return 1;
  }
  if (!runEnv) {
    return 0;
  }
  const startedAt = nowOf(io);
  const { arm } = liveWiring(runEnv, io);
  const main = runEnv.subscriptions.main;
  const agreementType = runEnv.agreementType ?? "unknown";
  const result = await harvestCost({
    client: liveCostClient(arm),
    subscriptionId: main,
    billingScope: `/subscriptions/${main}`,
    agreementType,
    asOf: startedAt.toISOString(),
  });
  if (!result.ok) {
    err(io, `cost harvest failed: ${result.reason}; nothing written`);
    return 1;
  }
  const { snapshot } = result;
  const totals: CostTotals = {
    kind: "cost-totals",
    liveRunAt: liveRunDate(startedAt),
    startedAt: startedAt.toISOString(),
    issues: [131],
    subscription: "main",
    billingScope: "/subscriptions/main",
    currency: snapshot.currency,
    agreementType,
    tolerancePercent: TOLERANCE_PERCENT,
    instructions:
      "Fill each portal value from Cost analysis (actual cost, same subscription, same month, grouped by service), then run npm run azure-live:cost -- --compare <this file>.",
    months: snapshot.months.map((figure) => ({ month: figure.periodStart.slice(0, 7), harvested: figure.costAmount, portal: null })),
    services: snapshot.services.map((figure) => ({
      serviceName: figure.serviceName,
      month: figure.periodStart.slice(0, 7),
      harvested: figure.costAmount,
      portal: null,
    })),
    untestedAgreementTypes: untestedAgreementTypes(runEnv.agreementType),
  };
  out(io, `wrote ${writeRecord(io, JSON.parse(aliasIds(runEnv, JSON.stringify(totals))) as CostTotals)}`);
  out(io, `untested agreement types: ${totals.untestedAgreementTypes.join(", ")}`);
  return 0;
}

function compare(file: string, io: RunIo): number {
  const path = isAbsolute(file) ? file : join(io.root ?? ROOT, file);
  const totals = JSON.parse(readFileSync(path, "utf8")) as CostTotals;
  if (totals.kind !== "cost-totals") {
    err(io, "not a cost-totals record");
    return 1;
  }
  const { matched, problems } = compareTotals(totals);
  const result = matched ? "pass" : "fail";
  const record = {
    kind: "cost-portal",
    liveRunAt: totals.liveRunAt,
    comparedAt: nowOf(io).toISOString(),
    issues: [131],
    totals: file,
    currency: totals.currency,
    agreementType: totals.agreementType,
    tolerancePercent: totals.tolerancePercent,
    matched,
    problems,
    untestedAgreementTypes: totals.untestedAgreementTypes,
    checks: [
      { checkId: "azure-cost-spend-by-service", result, defects: problems },
      { checkId: "azure-cost-month-on-month", result, defects: problems },
    ],
  };
  out(io, `wrote ${writeRecord(io, record)}`);
  out(io, matched ? "harvest totals match the portal" : `harvest totals do not match the portal:\n  ${problems.join("\n  ")}`);
  return matched ? 0 : 1;
}

export async function main(argv: string[] = [], io: RunIo = {}): Promise<number> {
  const index = argv.indexOf("--compare");
  if (index !== -1) {
    const file = argv[index + 1];
    if (!file) {
      err(io, "usage: cost-portal --compare <cost-totals file>");
      return 2;
    }
    return compare(file, io);
  }
  return harvest(io);
}

await runIfMain(import.meta.url, (argv) => main(argv));
