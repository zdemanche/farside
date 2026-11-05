import type { Money } from "./data/types";

const LOCALE = "en-GB";

const DATE_TIME = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const DATE = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeZone: "UTC",
});

export function Time({
  value,
  dateOnly = false,
  fallback = "unknown",
}: {
  value: string | null | undefined;
  dateOnly?: boolean;
  fallback?: string;
}) {
  const ms = value ? Date.parse(value) : Number.NaN;
  if (!value || Number.isNaN(ms) || ms <= 0) {
    return <>{fallback}</>;
  }
  return <time dateTime={value}>{dateOnly ? DATE.format(ms) : `${DATE_TIME.format(ms)} UTC`}</time>;
}

export function formatAmount(amount: string, currency: string): string {
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      currencyDisplay: "code",
    }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatMoney(money: Money | null): string {
  if (!money) {
    return "no estimate";
  }
  return `${formatAmount(money.min, money.currency)} to ${formatAmount(money.max, money.currency)} per ${money.period}`;
}
