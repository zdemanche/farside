export const PROVIDER_NOT_CONFIGURED = "No cloud provider is configured";

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super(PROVIDER_NOT_CONFIGURED);
    this.name = "ProviderNotConfiguredError";
  }
}

export function rejectUnconfigured(): never {
  throw new ProviderNotConfiguredError();
}
