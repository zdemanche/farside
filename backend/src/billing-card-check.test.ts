import { describe, expect, it } from "vitest";
import { assertNoCardData, CardDataError, keysOf } from "./billing.js";

/** The check as it was before, for comparison. */
function oldRejects(value: unknown): boolean {
  const text = JSON.stringify(value);
  return (
    /card|pan|cvv|cvc|cardnumber|card_number/i.test(text) || /\b(?:\d[ -]*?){13,19}\b/.test(text)
  );
}

function newRejects(value: unknown): boolean {
  try {
    assertNoCardData(value);
    return false;
  } catch (error) {
    if (error instanceof CardDataError) {
      return true;
    }
    throw error;
  }
}

describe("assertNoCardData: the key words are matched against keys only", () => {
  it("still rejects a card-like key, at any depth and inside arrays", () => {
    for (const key of ["cardNumber", "card_number", "cvv", "CVC", "pan", "creditCard"]) {
      expect(newRejects({ [key]: "x" })).toBe(true);
    }
    expect(newRejects({ payment: { details: [{ cardNumber: "x" }] } })).toBe(true);
  });

  it("accepts plan names that merely contain the letters pan, card or cvc", () => {
    for (const plan of [
      "Company",
      "Expansion",
      "Spanish",
      "Scorecard",
      "Pancake",
      "farside-standard",
    ]) {
      expect(newRejects({ plan })).toBe(false);
    }
  });

  it("accepts an ordinary contract", () => {
    expect(
      newRejects({
        plan: "farside-standard",
        startDate: "2026-10-01T00:00:00.000Z",
        amountDue: "1200.50",
      }),
    ).toBe(false);
  });
});

describe("assertNoCardData: a card number in any value is rejected exactly as before", () => {
  it("rejects real numbers in plain, spaced, dashed, embedded and Amex forms", () => {
    for (const note of [
      "4111111111111111",
      "4111 1111 1111 1111",
      "pay with 4111-1111-1111-1111 please",
      "378282246310005",
    ]) {
      expect(newRejects({ note })).toBe(true);
    }
  });

  it("rejects a number with digits in front, behind, or glued onto a group, and with repeated separators", () => {
    for (const note of [
      "Acme 2026-11 4242 4242 4242 4242",
      "ref 12 4111 1111 1111 1111",
      "4111  1111  1111  1111",
      "4111 - 1111 - 1111 - 1111",
      "4111111111111111123",
      "4111 1111 1111 1111123",
      "3782 822463 100051234",
      "274124 0776 4003 0467",
      "99" + "4111111111111111",
      "36000000000008123",
      "9792352407229382494",
    ]) {
      expect(newRejects({ note }), note).toBe(true);
    }
  });

  it("is unchanged for a long amount or id: still rejected, as before (this is a safeguard, not a classifier)", () => {
    expect(newRejects({ amountDue: "10000000000000" })).toBe(true);
    expect(newRejects({ id: "1234567890123" })).toBe(true);
  });

  it("accepts ISO dates and short numbers", () => {
    expect(newRejects({ startDate: "2026-10-01T00:00:00.000Z" })).toBe(false);
    expect(newRejects({ note: "version 1.2.3 build 4567, 2026 11 20 12 30" })).toBe(false);
  });

  it("agrees with the old check on 20000 generated values that contain no card word", () => {
    let seed = 20261121;
    const next = (max: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % max;
    };
    const parts = [
      "",
      " ",
      "-",
      ".",
      "  ",
      " - ",
      "a",
      "x",
      "ref",
      "PO",
      "2026",
      "11",
      "20",
      "4111",
      "1111",
      "12",
      "9",
    ];
    for (let round = 0; round < 20_000; round += 1) {
      let text = "";
      const length = 1 + next(24);
      for (let index = 0; index < length; index += 1) {
        text += parts[next(parts.length)];
        if (next(3) === 0) {
          text += String(next(10_000_000_000));
        }
      }
      expect(newRejects({ note: text }), text).toBe(oldRejects({ note: text }));
    }
  });
});

describe("keysOf", () => {
  it("walks a very deep body for keys without recursing, so it cannot overflow the stack", () => {
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let index = 0; index < 100_000; index += 1) {
      deep = { next: deep };
    }
    const keys = keysOf(deep);
    expect(keys).toHaveLength(100_001);
    expect(keys.at(-1)).toBe("leaf");
  });

  it("walks a cyclic body once, without looping", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(keysOf(cyclic).sort()).toEqual(["a", "self"]);
  });

  it("still checks a moderately deep body end to end", () => {
    let deep: Record<string, unknown> = { cardNumber: "x" };
    for (let index = 0; index < 300; index += 1) {
      deep = { next: deep };
    }
    expect(newRejects(deep)).toBe(true);
  });
});
