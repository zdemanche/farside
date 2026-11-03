export const CONTRACT_STATES = ["active", "warning", "grace", "paused", "retaining", "ended"] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

export const WARNING_DAYS = 7;
export const GRACE_DAYS = 14;
export const RETAIN_DAYS = 30;

export type Contract = {
  plan: string;
  startDate: string;
  endDate: string | null;
  state: ContractState;
  amountDue: string;
  currency: string;
  unpaidAt: string | null;
  stateChangedAt: string;
};

export type BillingView = {
  contract: Contract;
  canScan: boolean;
  invoices: never[];
  retainUntil: string | null;
};

const CARD_KEY = /card|pan|cvv|cvc|cardnumber|card_number/i;
const CARD_VALUE = /\b(?:\d[ -]*?){13,19}\b/;

export class CardDataError extends Error {
  constructor() {
    super("billing data must not hold card numbers");
    this.name = "CardDataError";
  }
}

export function assertNoCardData(value: unknown): void {
  const text = JSON.stringify(value);
  if (CARD_KEY.test(text) || CARD_VALUE.test(text)) {
    throw new CardDataError();
  }
}

const DAY_MS = 86_400_000;
const PAUSE_AFTER_DAYS = WARNING_DAYS + GRACE_DAYS;
const OFFBOARD_AFTER_DAYS = PAUSE_AFTER_DAYS + RETAIN_DAYS;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function validDate(value: unknown): value is string {
  return typeof value === "string" && ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
}

function normalised(value: string): string {
  return new Date(value).toISOString();
}

function hasEnded(contract: Contract, now: string): boolean {
  return (
    contract.state === "ended" ||
    (contract.endDate !== null && Date.parse(contract.endDate) <= Date.parse(now))
  );
}

export function effectiveContract(contract: Contract, now: string): Contract {
  if (hasEnded(contract, now)) {
    return {
      ...contract,
      state: "ended",
      stateChangedAt: contract.endDate ?? contract.stateChangedAt,
    };
  }
  if (!contract.unpaidAt) {
    return contract;
  }
  const elapsed = (Date.parse(now) - Date.parse(contract.unpaidAt)) / DAY_MS;
  const [days, state] =
    elapsed >= OFFBOARD_AFTER_DAYS
      ? ([OFFBOARD_AFTER_DAYS, "retaining"] as const)
      : elapsed >= PAUSE_AFTER_DAYS
        ? ([PAUSE_AFTER_DAYS, "paused"] as const)
        : elapsed >= WARNING_DAYS
          ? ([WARNING_DAYS, "grace"] as const)
          : ([0, "warning"] as const);
  return { ...contract, state, stateChangedAt: addDays(contract.unpaidAt, days) };
}

export function retainUntil(contract: Contract): string | null {
  const ended =
    contract.endDate ?? (contract.state === "ended" ? contract.stateChangedAt : null);
  const deadlines = [
    ended ? addDays(ended, RETAIN_DAYS) : null,
    contract.unpaidAt ? addDays(contract.unpaidAt, OFFBOARD_AFTER_DAYS) : null,
  ].filter((value): value is string => value !== null);
  return deadlines.length === 0
    ? null
    : deadlines.reduce((earliest, next) => (Date.parse(next) < Date.parse(earliest) ? next : earliest));
}

export function retentionElapsed(contract: Contract, now: string): boolean {
  const until = retainUntil(contract);
  return until !== null && Date.parse(now) >= Date.parse(until);
}

export function canScan(contract: Contract | null, now: string): boolean {
  if (!contract) {
    return true;
  }
  const { state } = effectiveContract(contract, now);
  return state === "active" || state === "warning" || state === "grace";
}

export function isReadOnly(contract: Contract | null, now: string): boolean {
  return contract !== null && !canScan(contract, now);
}

export function parseContract(body: unknown, now: string): Contract | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  assertNoCardData(record);
  if (typeof record.plan !== "string" || record.plan.length === 0) {
    return null;
  }
  if (!validDate(record.startDate)) {
    return null;
  }
  if (record.endDate != null && !validDate(record.endDate)) {
    return null;
  }
  if (record.unpaidAt != null && !validDate(record.unpaidAt)) {
    return null;
  }
  const unpaidAt = typeof record.unpaidAt === "string" ? normalised(record.unpaidAt) : null;
  const parsed: Contract = {
    plan: record.plan,
    startDate: normalised(record.startDate),
    endDate: typeof record.endDate === "string" ? normalised(record.endDate) : null,
    state: unpaidAt ? "warning" : "active",
    amountDue: typeof record.amountDue === "string" ? record.amountDue : "0.00",
    currency: typeof record.currency === "string" ? record.currency : "USD",
    unpaidAt,
    stateChangedAt: unpaidAt ?? now,
  };
  assertNoCardData(parsed);
  return parsed;
}

export function advanceContract(
  contract: Contract,
  input: { now: string; event?: "failed_payment" | "paid" | "ended" },
): Contract {
  if (input.event === "ended") {
    if (hasEnded(contract, input.now)) {
      return { ...contract, state: "ended", endDate: contract.endDate ?? contract.stateChangedAt };
    }
    return { ...contract, state: "ended", endDate: input.now, stateChangedAt: input.now };
  }
  if (input.event === "paid") {
    return {
      ...contract,
      state: "active",
      amountDue: "0.00",
      unpaidAt: null,
      stateChangedAt: input.now,
    };
  }
  if (input.event === "failed_payment" && contract.state === "active") {
    return {
      ...contract,
      state: "warning",
      unpaidAt: input.now,
      stateChangedAt: input.now,
    };
  }
  return effectiveContract(contract, input.now);
}

export function billingView(contract: Contract, now: string): BillingView {
  const effective = effectiveContract(contract, now);
  return {
    contract: effective,
    canScan: canScan(contract, now),
    invoices: [],
    retainUntil: retainUntil(contract),
  };
}
