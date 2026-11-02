import { describe, expect, it } from "vitest";
import { DISK_SAVINGS_BASIS, PointSavingsError, diskMonthlySavings, savingsRange } from "./savings.js";

describe("savings range helper", () => {
  it("computes a min/max range with the named basis", () => {
    const range = diskMonthlySavings(128);
    expect(range).toEqual({
      min: "8.00",
      max: "12.00",
      currency: "USD",
      basis: DISK_SAVINGS_BASIS,
    });
  });

  it("rejects a point value", () => {
    expect(() => savingsRange({ min: 10, max: 10, currency: "USD", basis: DISK_SAVINGS_BASIS })).toThrow(
      PointSavingsError,
    );
  });
});
