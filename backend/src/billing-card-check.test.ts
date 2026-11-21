import { describe, expect, it } from "vitest";
import { assertNoCardData, CardDataError, keysOf } from "./billing.js";

describe("assertNoCardData", () => {
  it("still rejects a card-like key", () => {
    for (const key of ["cardNumber", "card_number", "cvv", "cvc", "pan", "creditCard"]) {
      expect(() => assertNoCardData({ [key]: "x" })).toThrow(CardDataError);
    }
  });

  it("still rejects a nested card-like key", () => {
    expect(() => assertNoCardData({ payment: { details: [{ cardNumber: "x" }] } })).toThrow(
      CardDataError,
    );
  });

  it("still rejects a real card number in any value, with or without separators", () => {
    expect(() => assertNoCardData({ note: "4111111111111111" })).toThrow(CardDataError);
    expect(() => assertNoCardData({ note: "4111 1111 1111 1111" })).toThrow(CardDataError);
    expect(() => assertNoCardData({ note: "pay with 4111-1111-1111-1111 please" })).toThrow(
      CardDataError,
    );
    expect(() => assertNoCardData({ note: "378282246310005" })).toThrow(CardDataError);
  });

  it("accepts plan names that merely contain pan, card or cvc", () => {
    for (const plan of [
      "Company",
      "Expansion",
      "Spanish",
      "Scorecard",
      "Pancake",
      "farside-standard",
    ]) {
      expect(() => assertNoCardData({ plan })).not.toThrow();
    }
  });

  it("accepts a long amount or id that is not a card number", () => {
    expect(() => assertNoCardData({ amountDue: "10000000000000" })).not.toThrow();
    expect(() => assertNoCardData({ id: "1234567890123" })).not.toThrow();
    expect(() => assertNoCardData({ startDate: "2026-10-01T00:00:00.000Z" })).not.toThrow();
  });

  it("rejects a card number with another digit group in front of it", () => {
    for (const note of [
      "Acme 2026-11 4242 4242 4242 4242",
      "2026 4111 1111 1111 1111",
      "ref 12 4111 1111 1111 1111",
      "12 34 4111-1111-1111-1111",
    ]) {
      expect(() => assertNoCardData({ plan: note })).toThrow(CardDataError);
    }
  });

  it("rejects dot separators and a number joined to letters", () => {
    expect(() => assertNoCardData({ note: "4111.1111.1111.1111" })).toThrow(CardDataError);
    expect(() => assertNoCardData({ note: "x4111111111111111" })).toThrow(CardDataError);
  });

  it("walks a very deep body for keys without recursing, so it cannot overflow the stack", () => {
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let index = 0; index < 100_000; index += 1) {
      deep = { next: deep };
    }
    const keys = keysOf(deep);
    expect(keys).toHaveLength(100_001);
    expect(keys.at(-1)).toBe("leaf");
  });

  it("walks a cyclic body for keys once, without looping", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(keysOf(cyclic).sort()).toEqual(["a", "self"]);
  });

  it("still checks a moderately deep body end to end", () => {
    let deep: Record<string, unknown> = { cardNumber: "x" };
    for (let index = 0; index < 300; index += 1) {
      deep = { next: deep };
    }
    expect(() => assertNoCardData(deep)).toThrow(CardDataError);
  });

  it("does not take several short groups for a card number", () => {
    expect(() => assertNoCardData({ note: "2026-11-20 12 30 45" })).not.toThrow();
    expect(() => assertNoCardData({ note: "version 1.2.3 build 4567" })).not.toThrow();
  });
});
