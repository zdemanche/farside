import { describe, expect, it } from "vitest";
import { assertNoCardData, CardDataError } from "./billing.js";

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
});
