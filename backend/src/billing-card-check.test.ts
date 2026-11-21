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

  it("rejects a card number with repeated or spaced separators between groups", () => {
    for (const note of [
      "4111  1111  1111  1111",
      "4111 - 1111 - 1111 - 1111",
      "4111 -- 1111 .. 1111 -  1111",
      "ref  12  -  4111  1111  1111  1111",
    ]) {
      expect(() => assertNoCardData({ note })).toThrow(CardDataError);
    }
  });

  it("rejects a card number with a CVV, an expiry or other digits joined on in the same group", () => {
    for (const note of [
      "4111111111111111123",
      "4242424242424242314",
      "99" + "4111111111111111",
      "4111111111111111" + "99",
      "378282246310005" + "1234",
    ]) {
      expect(() => assertNoCardData({ note })).toThrow(CardDataError);
    }
  });

  it("still accepts a long amount or id that does not start like a card or does not pass Luhn", () => {
    for (const note of [
      "10000000000000",
      "1234567890123456",
      "1000000000000000001",
      "PO 2026 11 20 1234 5678",
    ]) {
      expect(() => assertNoCardData({ note })).not.toThrow();
    }
  });

  it("stays fast on a large body of tiny digit groups", () => {
    const started = Date.now();
    expect(() => assertNoCardData({ note: "1 - ".repeat(250_000) })).not.toThrow();
    expect(() => assertNoCardData({ note: "1-".repeat(500_000) })).not.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("rejects generated card numbers in many formats, seeded so it is repeatable", () => {
    let seed = 20261120;
    const next = (max: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % max;
    };
    const checkDigit = (body: string) => {
      for (let digit = 0; digit < 10; digit += 1) {
        const candidate = body + digit;
        let sum = 0;
        let double = false;
        for (let index = candidate.length - 1; index >= 0; index -= 1) {
          let value = Number(candidate[index]);
          if (double) {
            value *= 2;
            if (value > 9) {
              value -= 9;
            }
          }
          sum += value;
          double = !double;
        }
        if (sum % 10 === 0) {
          return candidate;
        }
      }
      throw new Error("no check digit");
    };
    const separators = [" ", "-", ".", "  ", " - ", "--", ""];
    for (let round = 0; round < 300; round += 1) {
      const length = [13, 15, 16, 19][next(4)] as number;
      const first = ["3", "4", "5", "6"][next(4)] as string;
      let body = first;
      while (body.length < length - 1) {
        body += String(next(10));
      }
      const number = checkDigit(body);
      const separator = separators[next(separators.length)] as string;
      const groups = number.match(/.{1,4}/g) as string[];
      const written = groups.join(separator);
      const lead = ["", "pay ", "ref 12 ", "Acme 2026-11 ", "99 - "][next(5)] as string;
      const tail = ["", " please", " 123", ""][next(4)] as string;
      const text = `${lead}${written}${tail}`;
      expect(() => assertNoCardData({ note: text }), text).toThrow(CardDataError);
    }
  });
});
