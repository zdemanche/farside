import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Cloud } from "@farside/scan-contracts";
import azureSpec from "../../docs/azure/launch-checks.json" with { type: "json" };
import gcpSpec from "../../docs/gcp/launch-checks.json" with { type: "json" };
import { providerFor } from "./providers/index.js";

export const TOKEN_FLAG_MESSAGE =
  "credentials must come from Azure CLI / DefaultAzureCredential or GCP Application Default Credentials; token flags are refused";

const TOKEN_FLAG_NAMES = new Set([
  "token",
  "access-token",
  "accesstoken",
  "refresh-token",
  "client-secret",
  "client_secret",
  "password",
]);

type LaunchSpec = { checks: Array<{ id: string; role: string }> };

const SPECS: Record<Cloud, LaunchSpec> = {
  azure: azureSpec as LaunchSpec,
  gcp: gcpSpec as LaunchSpec,
};

export type CredentialProbe = {
  present: boolean;
  source: "azure-cli" | "azure-adc" | "gcp-adc" | "none";
  error?: string;
};

export type RoleGap = {
  role: string;
  required: boolean;
  blockedCheckIds: string[];
};

export function isTokenFlag(name: string): boolean {
  const normalized = name.replace(/_/g, "-").toLowerCase();
  return TOKEN_FLAG_NAMES.has(normalized);
}

export function checksForRole(cloud: Cloud, role: string): string[] {
  return SPECS[cloud].checks.filter((check) => check.role === role).map((check) => check.id);
}

export function specRoles(cloud: Cloud): string[] {
  const roles: string[] = [];
  const seen = new Set<string>();
  for (const check of SPECS[cloud].checks) {
    if (seen.has(check.role)) {
      continue;
    }
    seen.add(check.role);
    roles.push(check.role);
  }
  return roles;
}

export function missingRoles(cloud: Cloud, granted: readonly string[]): RoleGap[] {
  const have = new Set(granted);
  const provider = providerFor(cloud);
  const optional = new Set(provider.optionalRoles);
  const fromProvider = [
    ...provider.requiredRoles
      .filter((role) => !have.has(role))
      .map((role) => ({ role, required: true, blockedCheckIds: checksForRole(cloud, role) })),
    ...provider.optionalRoles
      .filter((role) => !have.has(role))
      .map((role) => ({ role, required: false, blockedCheckIds: checksForRole(cloud, role) })),
  ];
  if (fromProvider.length > 0) {
    return fromProvider;
  }
  return specRoles(cloud)
    .filter((role) => !have.has(role))
    .map((role) => ({
      role,
      required: !optional.has(role),
      blockedCheckIds: checksForRole(cloud, role),
    }));
}

export function probeLocalCredentials(
  cloud: Cloud,
  env: NodeJS.Dict<string> = process.env,
  home: string = env.HOME ?? homedir(),
): CredentialProbe {
  if (cloud === "gcp") {
    const adc = env.GOOGLE_APPLICATION_CREDENTIALS;
    const path =
      typeof adc === "string" && adc.length > 0
        ? adc
        : join(home, ".config/gcloud/application_default_credentials.json");
    return existsSync(path)
      ? { present: true, source: "gcp-adc" }
      : {
          present: false,
          source: "gcp-adc",
          error: "GCP Application Default Credentials are required",
        };
  }
  if (typeof env.AZURE_CLIENT_SECRET === "string" && env.AZURE_CLIENT_SECRET.length > 0) {
    return {
      present: false,
      source: "none",
      error: "client secrets are refused; use Azure CLI or federated DefaultAzureCredential",
    };
  }
  if (existsSync(join(home, ".azure"))) {
    return { present: true, source: "azure-cli" };
  }
  if (typeof env.AZURE_CLIENT_ID === "string" && env.AZURE_CLIENT_ID.length > 0) {
    return { present: true, source: "azure-adc" };
  }
  return {
    present: false,
    source: "none",
    error: "signed-in Azure CLI or DefaultAzureCredential is required",
  };
}
