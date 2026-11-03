import { describe, expect, it } from "vitest";
import { SharedAccountError, parseAccountRegistry } from "./account.js";
import { materializeDevStack } from "./index.js";

const registry = parseAccountRegistry(
  JSON.stringify({
    productDev: { customer: "moonaan-dev", accountId: "123456789012" },
    customers: {},
  }),
);

describe("materializeDevStack", () => {
  it("returns tagged resource names for the dedicated account", () => {
    const outputs = materializeDevStack({
      customerName: "moonaan-dev",
      accountId: "123456789012",
      environment: "dev",
      callerAccountId: "123456789012",
      registry,
    });
    expect(outputs.address).toBe("farside.moonaan-dev.moonaan.com");
    expect(outputs.healthPath).toBe("/health");
    expect(outputs.resourceNames).toContain("farside-moonaan-dev-health");
    expect(outputs.resourceNames).toContain("farside-moonaan-dev-console");
    expect(outputs.tags.customer).toBe("moonaan-dev");
  });

  it("does not materialize when the caller is another product or customer account", () => {
    expect(() =>
      materializeDevStack({
        customerName: "moonaan-dev",
        accountId: "123456789012",
        environment: "dev",
        callerAccountId: "111111111111",
        registry,
      }),
    ).toThrow(SharedAccountError);
  });
});
