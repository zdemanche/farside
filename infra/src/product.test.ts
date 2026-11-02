import { describe, expect, it } from "vitest";
import {
  ADDRESS_PATTERN,
  AGREED_REPO,
  DEPLOYMENT_KEY,
  PRODUCT_KEY,
  customerAddress,
} from "./product.js";

describe("product naming", () => {
  it("uses the agreed key and address pattern", () => {
    expect(PRODUCT_KEY).toBe("farside");
    expect(DEPLOYMENT_KEY).toBe("farside");
    expect(ADDRESS_PATTERN).toBe("farside.<customer>.moonaan.com");
    expect(customerAddress("moonaan-dev")).toBe("farside.moonaan-dev.moonaan.com");
  });

  it("rejects a customer name that is not a tenant slug", () => {
    expect(() => customerAddress("Moonaan-Dev")).toThrow(/tenant slug/);
  });

  it("records the agreed Moonaan repo separately from this working clone", () => {
    expect(AGREED_REPO).toBe("Moonaan/moonaan-farside");
  });
});
