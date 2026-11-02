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
