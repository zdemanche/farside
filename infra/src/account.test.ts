import { describe, expect, it } from "vitest";
import {
  SharedAccountError,
  assertDedicatedAccount,
  parseAccountRegistry,
  loadAccountRegistry,
} from "./account.js";

const registry = parseAccountRegistry(
  JSON.stringify({
    productDev: { customer: "moonaan-dev", accountId: "100000000000" },
    customers: { acme: "123456789012", globex: "222222222222" },
  }),
);

describe("dedicated account guard", () => {
  it("allows a registered customer account that matches the caller", () => {
    expect(() =>
      assertDedicatedAccount("123456789012", "123456789012", "acme", registry),
    ).not.toThrow();
  });

  it("allows product-dev only for its own slug", () => {
    expect(() =>
      assertDedicatedAccount(
        "100000000000",
        "100000000000",
        "moonaan-dev",
        registry,
      ),
    ).not.toThrow();
  });

  it("refuses a caller account that differs from the expected account", () => {
    expect(() =>
      assertDedicatedAccount("999999999999", "123456789012", "acme", registry),
    ).toThrow(SharedAccountError);
  });

  it("refuses an account absent from the registry even when it equals the caller", () => {
    expect(() =>
      assertDedicatedAccount("333333333333", "333333333333", "acme", registry),
    ).toThrow(SharedAccountError);
  });

  it("refuses an account mapped to another customer even when it equals the caller", () => {
    expect(() =>
      assertDedicatedAccount("222222222222", "222222222222", "acme", registry),
    ).toThrow(SharedAccountError);
  });

  it("refuses the product-dev account for a customer", () => {
    expect(() =>
      assertDedicatedAccount("100000000000", "100000000000", "acme", registry),
    ).toThrow(SharedAccountError);
  });

  it("refuses a customer slug that is not registered", () => {
    expect(() =>
      assertDedicatedAccount(
        "123456789012",
        "123456789012",
        "initech",
        registry,
      ),
    ).toThrow(SharedAccountError);
  });

  it("does not resolve inherited object keys as customers", () => {
    expect(() =>
      assertDedicatedAccount(
        "123456789012",
        "123456789012",
        "constructor",
        registry,
      ),
    ).toThrow(SharedAccountError);
  });

  it("refuses a malformed expected account id", () => {
    expect(() =>
      assertDedicatedAccount("123456789012", "dev", "acme", registry),
    ).toThrow(/12-digit/);
  });
});

describe("account registry", () => {
  it("rejects one account registered to two customers", () => {
    const duplicate = JSON.stringify({
      productDev: { customer: "moonaan-dev", accountId: "100000000000" },
      customers: { acme: "123456789012", globex: "123456789012" },
    });
    expect(() => parseAccountRegistry(duplicate)).toThrow(SharedAccountError);
  });

  it("rejects a malformed account id", () => {
    const bad = JSON.stringify({
      productDev: { customer: "moonaan-dev", accountId: "1" },
      customers: {},
    });
    expect(() => parseAccountRegistry(bad)).toThrow(/12-digit/);
  });

  it("loads the committed registry", () => {
    const committed = loadAccountRegistry(
      new URL("../accounts.json", import.meta.url).pathname,
    );
    expect(committed.productDev.customer).toBe("moonaan-dev");
  });
});
