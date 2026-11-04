import docGcpAlertReplay from "../../docs/gcp/alert-replay.json" with { type: "json" };
import docAzureAlertReplay from "../../docs/azure/alert-replay.json" with { type: "json" };

export const WINDOW_DAYS = 14;
export const ORG_SPIKE_MULT = 1.25;
export const SUBSCRIPTION_SPIKE_MULT = 2;
export const SUBSCRIPTION_DELTA_MULT = 0.25;
export const SERVICE_SPIKE_MULT = 3;
export const NEW_SERVICE_ORG_SHARE = 0.05;

export type AlertKind = "ORG_SPIKE" | "SUBSCRIPTION_SPIKE" | "SERVICE_SPIKE" | "NEW_SERVICE";

export type DailyCost = {
  date: string;
  subscriptionId: string;
  serviceName: string;
  costAmount: string;
  currency: string;
};

export type FloorBurstPoint = {
  date: string;
  actual: string;
  floor: string;
  burst: string;
  currency: string;
};

export type SpendAlert = {
  id: string;
  kind: AlertKind;
  date: string;
  scope: string;
  amount: string;
  baseline: string;
  currency: string;
  isNew: boolean;
};

export type AlertDigest = {
  date: string;
  recipients: string[];
  alerts: SpendAlert[];
  withheldRepeats: number;
  delivered: boolean;
  reason: "no_mail_path" | "no_recipients" | "no_new_alerts" | "sent";
};

export type DigestMailer = {
  send: (digest: AlertDigest) => void;
};

export function memoryMailer() {
  const sent: AlertDigest[] = [];
  return {
    sent,
    send(digest: AlertDigest) {
      sent.push(digest);
    },
  };
}

export function deliverDigest(digest: AlertDigest, mailer?: DigestMailer): AlertDigest {
  if (digest.reason !== "no_mail_path" || !mailer) {
    return digest;
  }
  const next = { ...digest, delivered: true, reason: "sent" as const };
  mailer.send(next);
  return next;
}

export type HistoryGate = {
  historyDays: number;
  daysNeeded: number;
  closer: string;
  reason?: "mixed_currency";
};

export const CURRENCY_CLOSER = "Daily cost rows in a single currency";

function mixedCurrencyGate(rows: DailyCost[], asOf: string): HistoryGate | null {
  const currencies = new Set(rows.filter((row) => row.date <= asOf).map((row) => row.currency));
  return currencies.size > 1
    ? { historyDays: historyDays(rows, asOf), daysNeeded: 0, closer: CURRENCY_CLOSER, reason: "mixed_currency" }
    : null;
}

export type AlertAnalysis = {
  asOf: string;
  historyDays: number;
  floorBurst: FloorBurstPoint[];
  alerts: SpendAlert[];
  digest: AlertDigest;
  undetermined: HistoryGate | null;
};

type ReplayFile = {
  windowDays: number;
  asOf: string;
  expectedNewAlerts: number;
  rows: DailyCost[];
};

export type GcpDailyCost = {
  date: string;
  projectId: string;
  serviceName: string;
  costAmount: string;
  currency: string;
};

type GcpReplayFile = {
  cloud: "gcp";
  windowDays: number;
  asOf: string;
  expectedNewAlerts: number;
  rows: GcpDailyCost[];
};

const GCP_REPLAY = docGcpAlertReplay as GcpReplayFile;

const REPLAY = docAzureAlertReplay as ReplayFile;

export function replayFixture(): ReplayFile {
  return REPLAY;
}

export function gcpReplayFixture(): GcpReplayFile {
  return GCP_REPLAY;
}

export function gcpRowsToDailyCost(rows: GcpDailyCost[]): DailyCost[] {
  return rows.map((row) => ({
    date: row.date,
    subscriptionId: row.projectId,
    serviceName: row.serviceName,
    costAmount: row.costAmount,
    currency: row.currency,
  }));
}

function toNumber(amount: string): number {
  return Number(amount);
}

function money(amount: number): string {
  return amount.toFixed(2);
}

function add(amounts: string[]): string {
  return money(amounts.reduce((sum, amount) => sum + toNumber(amount), 0));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.floor(p * (sorted.length - 1));
  return sorted[index] ?? 0;
}

function datesOnOrBefore(rows: DailyCost[], asOf: string): string[] {
  return [...new Set(rows.filter((row) => row.date <= asOf).map((row) => row.date))].sort();
}

export function historyDays(rows: DailyCost[], asOf: string): number {
  return datesOnOrBefore(rows, asOf).filter((date) => date < asOf).length;
}

export function historyCloser(daysNeeded: number): string {
  return `${daysNeeded} more completed export day${daysNeeded === 1 ? "" : "s"}`;
}

function orgTotal(rows: DailyCost[], date: string): string {
  return add(rows.filter((row) => row.date === date).map((row) => row.costAmount));
}

function subscriptionTotal(rows: DailyCost[], date: string, subscriptionId: string): string {
  return add(
    rows
      .filter((row) => row.date === date && row.subscriptionId === subscriptionId)
      .map((row) => row.costAmount),
  );
}

function serviceTotal(
  rows: DailyCost[],
  date: string,
  subscriptionId: string,
  serviceName: string,
): string {
  return add(
    rows
      .filter(
        (row) =>
          row.date === date && row.subscriptionId === subscriptionId && row.serviceName === serviceName,
      )
      .map((row) => row.costAmount),
  );
}

export function floorBurst(rows: DailyCost[], asOf: string): FloorBurstPoint[] {
  const dates = datesOnOrBefore(rows, asOf);
  const currency = rows[0]?.currency ?? "USD";
  return dates.flatMap((date, index) => {
    const window = dates.slice(Math.max(0, index - WINDOW_DAYS), index).map((prior) => toNumber(orgTotal(rows, prior)));
    if (window.length === 0) {
      return [];
    }
    const actual = toNumber(orgTotal(rows, date));
    const floor = Math.min(...window);
    return [{ date, actual: money(actual), floor: money(floor), burst: money(actual - floor), currency }];
  });
}

function priorAmounts(dates: string[], asOf: string, valueOn: (date: string) => number): number[] {
  return dates.filter((date) => date < asOf).slice(-WINDOW_DAYS).map(valueOn);
}

function alertId(kind: AlertKind, scope: string, date: string): string {
  return `${kind}:${scope}:${date}`;
}

function previousDay(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

export function evaluateAlerts(
  rows: DailyCost[],
  asOf: string,
  previous: SpendAlert[] = [],
): { alerts: SpendAlert[]; undetermined: HistoryGate | null; historyDays: number } {
  const mixed = mixedCurrencyGate(rows, asOf);
  if (mixed) {
    return { alerts: [], historyDays: mixed.historyDays, undetermined: mixed };
  }
  const dates = datesOnOrBefore(rows, asOf);
  const priorDates = dates.filter((date) => date < asOf);
  const available = priorDates.length;
  if (available < WINDOW_DAYS) {
    const daysNeeded = WINDOW_DAYS - available;
    return {
      alerts: [],
      historyDays: available,
      undetermined: { historyDays: available, daysNeeded, closer: historyCloser(daysNeeded) },
    };
  }
  const currency = rows[0]?.currency ?? "USD";
  const orgPrior = priorAmounts(dates, asOf, (date) => toNumber(orgTotal(rows, date)));
  const orgToday = toNumber(orgTotal(rows, asOf));
  const orgMean = mean(orgPrior);
  const orgP95 = percentile(orgPrior, 0.95);
  const mark = (kind: AlertKind, scope: string, amount: number, baseline: number): SpendAlert => {
    const seen = previous.some(
      (alert) => alert.kind === kind && alert.scope === scope && alert.date === previousDay(asOf),
    );
    return {
      id: alertId(kind, scope, asOf),
      kind,
      date: asOf,
      scope,
      amount: money(amount),
      baseline: money(baseline),
      currency,
      isNew: !seen,
    };
  };
  const alerts: SpendAlert[] = [];
  if (orgToday > ORG_SPIKE_MULT * orgP95 && orgToday > ORG_SPIKE_MULT * orgMean) {
    alerts.push(mark("ORG_SPIKE", "org", orgToday, orgP95));
  }
  const subscriptions = [...new Set(rows.map((row) => row.subscriptionId))];
  for (const subscriptionId of subscriptions) {
    const prior = priorAmounts(dates, asOf, (date) => toNumber(subscriptionTotal(rows, date, subscriptionId)));
    const today = toNumber(subscriptionTotal(rows, asOf, subscriptionId));
    const priorMean = mean(prior);
    if (today > SUBSCRIPTION_SPIKE_MULT * priorMean && today - priorMean > SUBSCRIPTION_DELTA_MULT * priorMean) {
      alerts.push(mark("SUBSCRIPTION_SPIKE", subscriptionId, today, priorMean));
    }
    const services = [
      ...new Set(rows.filter((row) => row.subscriptionId === subscriptionId).map((row) => row.serviceName)),
    ];
    for (const serviceName of services) {
      const servicePrior = priorAmounts(dates, asOf, (date) =>
        toNumber(serviceTotal(rows, date, subscriptionId, serviceName)),
      );
      const serviceToday = toNumber(serviceTotal(rows, asOf, subscriptionId, serviceName));
      const serviceMean = mean(servicePrior);
      const scope = `${subscriptionId}:${serviceName}`;
      if (serviceMean === 0 && serviceToday > NEW_SERVICE_ORG_SHARE * orgMean) {
        alerts.push(mark("NEW_SERVICE", scope, serviceToday, orgMean * NEW_SERVICE_ORG_SHARE));
      } else if (serviceMean > 0 && serviceToday > SERVICE_SPIKE_MULT * serviceMean) {
        alerts.push(mark("SERVICE_SPIKE", scope, serviceToday, serviceMean));
      }
    }
  }
  return { alerts, undetermined: null, historyDays: available };
}

export function buildDigest(
  asOf: string,
  alerts: SpendAlert[],
  recipients: string[],
): AlertDigest {
  const fresh = alerts.filter((alert) => alert.isNew);
  const withheldRepeats = alerts.length - fresh.length;
  let reason: AlertDigest["reason"] = "no_mail_path";
  if (fresh.length === 0) {
    reason = "no_new_alerts";
  } else if (recipients.length === 0) {
    reason = "no_recipients";
  }
  return {
    date: asOf,
    recipients,
    alerts: fresh,
    withheldRepeats,
    delivered: false,
    reason,
  };
}

export function analyzeAlerts(input: {
  rows: DailyCost[];
  asOf: string;
  previous?: SpendAlert[];
  recipients?: string[];
  mailer?: DigestMailer | undefined;
}): AlertAnalysis {
  const rows = input.rows;
  const asOf = input.asOf;
  const evaluated = evaluateAlerts(rows, asOf, input.previous ?? []);
  return {
    asOf,
    historyDays: evaluated.historyDays,
    floorBurst: evaluated.undetermined?.reason === "mixed_currency" ? [] : floorBurst(rows, asOf),
    alerts: evaluated.alerts,
    digest: deliverDigest(buildDigest(asOf, evaluated.alerts, input.recipients ?? []), input.mailer),
    undetermined: evaluated.undetermined,
  };
}

export function backtest(rows: DailyCost[] = replayFixture().rows, asOf = replayFixture().asOf): number {
  return analyzeAlerts({ rows, asOf }).alerts.filter((alert) => alert.isNew).length;
}
