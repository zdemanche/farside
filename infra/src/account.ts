/**
 * Farside must land in a dedicated Moonaan-owned account for that customer
 * (or the product-dev account). Sharing an account with another product or
 * customer is a hard failure, not a warning.
 */
export class SharedAccountError extends Error {
  constructor(actualAccountId: string, expectedAccountId: string) {
    super(
      `Refusing to deploy Farside into account ${actualAccountId}; expected dedicated account ${expectedAccountId}.`,
    );
    this.name = "SharedAccountError";
  }
}

export function assertDedicatedAccount(actualAccountId: string, expectedAccountId: string): void {
  if (!/^\d{12}$/.test(expectedAccountId)) {
    throw new Error("farside:accountId must be a 12-digit AWS account id");
  }
  if (actualAccountId !== expectedAccountId) {
    throw new SharedAccountError(actualAccountId, expectedAccountId);
  }
}
