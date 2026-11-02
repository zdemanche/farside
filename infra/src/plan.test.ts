import { describe, expect, it } from "vitest";
import { REQUIRED_TAG_KEYS } from "./tags.js";
import { planDevStack, untaggedResources } from "./plan.js";

describe("dev deploy plan", () => {
  const plan = planDevStack({
    customerName: "moonaan-dev",
    environment: "dev",
    accountId: "000000000000",
  });

  it("plans a health lambda and a console shell in the dedicated account", () => {
    expect(plan.accountId).toBe("000000000000");
    expect(plan.healthPath).toBe("/health");
    expect(plan.resources.map((resource) => resource.kind)).toEqual([
      "iam-role",
      "lambda",
      "lambda-url",
      "s3-bucket",
      "cloudfront",
      "dns-record",
    ]);
  });

  it("tags every resource with the standard Moonaan set", () => {
    expect(untaggedResources(plan)).toEqual([]);
    for (const key of REQUIRED_TAG_KEYS) {
      expect(plan.tags[key]).toBeTruthy();
    }
    expect(plan.tags.product).toBe("farside");
    expect(plan.tags.customer).toBe("moonaan-dev");
    expect(plan.tags.managedBy).toBe("pulumi");
  });
});
