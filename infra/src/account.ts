import { readFileSync } from "node:fs";

export type AccountRegistry = {
  productDev: { customer: string; accountId: string };
  customers: Record<string, string>;
};

const ACCOUNT_ID = /^\d{12}$/;

export class SharedAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedAccountError";
  }
}

export function parseAccountRegistry(raw: string): AccountRegistry {
  const parsed = JSON.parse(raw) as Partial<AccountRegistry>;
  const productDev = parsed.productDev;
  const customers = parsed.customers;
  if (
    !productDev ||
    typeof productDev.customer !== "string" ||
    !customers ||
    typeof customers !== "object" ||
    Array.isArray(customers)
  ) {
    throw new Error("account registry needs productDev and a customers object");
  }
  if (Object.hasOwn(customers, productDev.customer)) {
    throw new SharedAccountError(`Customer ${productDev.customer} is the product-dev slug and cannot also be a customer.`);
  }
  const entries: [string, unknown][] = [[productDev.customer, productDev.accountId], ...Object.entries(customers)];
  const owners = new Map<string, string>();
  for (const [customer, accountId] of entries) {
    if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) {
      throw new Error(`account registry entry for ${customer} must be a 12-digit AWS account id`);
    }
    const other = owners.get(accountId);
    if (other !== undefined) {
      throw new SharedAccountError(`Account ${accountId} is registered to both ${other} and ${customer}.`);
    }
    owners.set(accountId, customer);
  }
  return { productDev, customers };
}

export function loadAccountRegistry(path: string): AccountRegistry {
  return parseAccountRegistry(readFileSync(path, "utf8"));
}

function registeredAccount(
  registry: AccountRegistry,
  customer: string,
): string | undefined {
  if (customer === registry.productDev.customer) {
    return registry.productDev.accountId;
  }
  return Object.hasOwn(registry.customers, customer)
    ? registry.customers[customer]
    : undefined;
}

export function assertDedicatedAccount(
  actualAccountId: string,
  expectedAccountId: string,
  customer: string,
  registry: AccountRegistry,
): void {
  if (!ACCOUNT_ID.test(expectedAccountId)) {
    throw new Error("farside:accountId must be a 12-digit AWS account id");
  }
  const registered = registeredAccount(registry, customer);
  if (registered === undefined) {
    throw new SharedAccountError(
      `Customer ${customer} has no dedicated account in the Moonaan registry.`,
    );
  }
  if (registered !== expectedAccountId) {
    throw new SharedAccountError(
      `Account ${expectedAccountId} is not the registered dedicated account for ${customer}.`,
    );
  }
  if (actualAccountId !== expectedAccountId) {
    throw new SharedAccountError(
      `Refusing to deploy Farside into account ${actualAccountId}; expected dedicated account ${expectedAccountId}.`,
    );
  }
}
