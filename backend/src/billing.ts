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

export function canScan(contract: Contract | null): boolean {
  if (!contract) {
    return true;
  }
  return contract.state === "active" || contract.state === "warning" || contract.state === "grace";
}

function daysBetween(later: string, earlier: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / 86_400_000;
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
  if (typeof record.startDate !== "string" || record.startDate.length === 0) {
    return null;
  }
  const state = CONTRACT_STATES.includes(record.state as ContractState)
    ? (record.state as ContractState)
    : "active";
  const parsed: Contract = {
    plan: record.plan,
    startDate: record.startDate,
    endDate: typeof record.endDate === "string" ? record.endDate : null,
    state,
    amountDue: typeof record.amountDue === "string" ? record.amountDue : "0.00",
    currency: typeof record.currency === "string" ? record.currency : "USD",
    unpaidAt: typeof record.unpaidAt === "string" ? record.unpaidAt : null,
    stateChangedAt: typeof record.stateChangedAt === "string" ? record.stateChangedAt : now,
  };
  assertNoCardData(parsed);
  return parsed;
}

export function advanceContract(
  contract: Contract,
  input: { now: string; event?: "failed_payment" | "paid" | "ended" },
): Contract {
  if (input.event === "ended") {
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
  const since = contract.stateChangedAt;
  if (contract.state === "warning" && daysBetween(input.now, since) >= WARNING_DAYS) {
    return { ...contract, state: "grace", stateChangedAt: input.now };
  }
  if (contract.state === "grace" && daysBetween(input.now, since) >= GRACE_DAYS) {
    return { ...contract, state: "paused", stateChangedAt: input.now };
  }
  if (contract.state === "paused" && daysBetween(input.now, since) >= RETAIN_DAYS) {
    return { ...contract, state: "retaining", stateChangedAt: input.now };
  }
  return contract;
}

export function billingView(contract: Contract): BillingView {
  return { contract, canScan: canScan(contract), invoices: [] };
}
