import { describe, expect, it } from "vitest";
import { SharedAccountError, assertDedicatedAccount } from "./account.js";

describe("dedicated account guard", () => {
  it("allows a matching 12-digit account", () => {
    expect(() => assertDedicatedAccount("123456789012", "123456789012")).not.toThrow();
  });

  it("refuses a different account so resources cannot land in a shared product account", () => {
    expect(() => assertDedicatedAccount("999999999999", "123456789012")).toThrow(SharedAccountError);
  });

  it("refuses a malformed expected account id", () => {
    expect(() => assertDedicatedAccount("123456789012", "dev")).toThrow(/12-digit/);
  });
});
