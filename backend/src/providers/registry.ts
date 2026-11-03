import type { Cloud } from "@farside/scan-contracts";
import type { CheckDefinition } from "../checks/define.js";
import type { CloudProvider } from "./types.js";

export const DEFAULT_CLOUD: Cloud = "azure";

const providers = new Map<Cloud, CloudProvider>();

export class UnknownCloudError extends Error {
  constructor(cloud: string) {
    super(`no provider is registered for cloud '${cloud}'`);
    this.name = "UnknownCloudError";
  }
}

export function registerProvider(provider: CloudProvider): void {
  providers.set(provider.cloud, provider);
}

export function providerFor(cloud: Cloud): CloudProvider {
  const provider = providers.get(cloud);
  if (!provider) {
    throw new UnknownCloudError(cloud);
  }
  return provider;
}

export function allProviders(): CloudProvider[] {
  return [...providers.values()];
}

export function findCheck(checkId: string): CheckDefinition | undefined {
  for (const provider of providers.values()) {
    const check = provider.checks.find((candidate) => candidate.checkId === checkId);
    if (check) {
      return check;
    }
  }
  return undefined;
}

export function registeredCheckIds(cloud: Cloud): string[] {
  return providerFor(cloud).checks.map((check) => check.checkId);
}
