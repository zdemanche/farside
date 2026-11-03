import type { Money } from "./data/types";

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const DATE = new Intl.DateTimeFormat("en-GB", {
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
  return (
    <time dateTime={value}>
      {dateOnly ? DATE.format(ms) : `${DATE_TIME.format(ms)} UTC`}
    </time>
  );
}

export function formatMoney(money: Money | null): string {
  if (!money) {
    return "no estimate";
  }
  try {
    const currency = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: money.currency,
      currencyDisplay: "code",
    });
    return `${currency.format(Number(money.min))} to ${currency.format(Number(money.max))} per ${money.period}`;
  } catch {
    return `${money.min} to ${money.max} ${money.currency} per ${money.period}`;
  }
}
