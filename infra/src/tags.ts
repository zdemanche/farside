/**
 * Tags applied to every Farside resource. Shape follows Moonaan Identity
 * (`domain`, `system`, `customer`, `managedBy`) plus `product` so cost and
 * inventory queries can separate Farside from other products in an account.
 */
export type FarsideTagInput = {
  customerName: string;
  environment: "dev" | "non-prod" | "prod" | "prod-critical";
};

export type FarsideTags = {
  domain: "farside";
  system: "moonaan-farside";
  product: "farside";
  customer: string;
  environment: FarsideTagInput["environment"];
  managedBy: "pulumi";
};

export function moonaanTags(input: FarsideTagInput): FarsideTags {
  return {
    domain: "farside",
    system: "moonaan-farside",
    product: "farside",
    customer: input.customerName,
    environment: input.environment,
    managedBy: "pulumi",
  };
}

export const REQUIRED_TAG_KEYS = [
  "domain",
  "system",
  "product",
  "customer",
  "environment",
  "managedBy",
] as const;
