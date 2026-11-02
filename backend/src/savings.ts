export const DISK_SAVINGS_BASIS =
  "Monthly list price of the unused disk SKU and size, as a range";

export class PointSavingsError extends Error {
  constructor() {
    super("single point value is rejected; use a min/max range");
    this.name = "PointSavingsError";
  }
}

export type NamedSavingsRange = {
  min: string;
  max: string;
  currency: string;
  basis: string;
};

export function savingsRange(input: {
  min: number;
  max: number;
  currency: string;
  basis: string;
}): NamedSavingsRange {
  if (input.min === input.max) {
    throw new PointSavingsError();
  }
  if (input.basis.length === 0) {
    throw new Error("savings basis is required");
  }
  const min = input.min.toFixed(2);
  const max = input.max.toFixed(2);
  if (min === max) {
    throw new PointSavingsError();
  }
  return { min, max, currency: input.currency, basis: input.basis };
}

export function diskMonthlySavings(sizeGb: number): NamedSavingsRange {
  return savingsRange({
    min: sizeGb * 0.0625,
    max: sizeGb * 0.09375,
    currency: "USD",
    basis: DISK_SAVINGS_BASIS,
  });
}

export const SNAPSHOT_SAVINGS_BASIS =
  "Monthly list price of snapshot storage for the retained size, as a range";
export const PUBLIC_IP_SAVINGS_BASIS = "Monthly list price of the unused public IP SKU, as a range";
export const STOPPED_VM_SAVINGS_BASIS =
  "Monthly compute list price of the VM size while stopped-but-allocated, as a range";

export function snapshotMonthlySavings(): NamedSavingsRange {
  return savingsRange({ min: 1, max: 3, currency: "USD", basis: SNAPSHOT_SAVINGS_BASIS });
}

export function publicIpMonthlySavings(): NamedSavingsRange {
  return savingsRange({ min: 3, max: 5, currency: "USD", basis: PUBLIC_IP_SAVINGS_BASIS });
}

export function stoppedVmMonthlySavings(): NamedSavingsRange {
  return savingsRange({ min: 30.4, max: 45.6, currency: "USD", basis: STOPPED_VM_SAVINGS_BASIS });
}

export const EMPTY_PLAN_SAVINGS_BASIS = "Monthly list price of the empty plan SKU, as a range";
export const IDLE_LB_SAVINGS_BASIS =
  "Monthly list price of the unused load balancer SKU, as a range";
export const IDLE_NAT_SAVINGS_BASIS = "Monthly list price of the unused NAT gateway, as a range";

export function emptyPlanMonthlySavings(): NamedSavingsRange {
  return savingsRange({ min: 70, max: 105, currency: "USD", basis: EMPTY_PLAN_SAVINGS_BASIS });
}

export function idleLbMonthlySavings(): NamedSavingsRange {
  return savingsRange({ min: 18, max: 27, currency: "USD", basis: IDLE_LB_SAVINGS_BASIS });
}

export function idleNatMonthlySavings(): NamedSavingsRange {
  return savingsRange({ min: 32, max: 48, currency: "USD", basis: IDLE_NAT_SAVINGS_BASIS });
}
