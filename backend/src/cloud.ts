import { CLOUDS, type Cloud } from "@farside/scan-contracts";
import { DEFAULT_CLOUD } from "./providers/registry.js";

export type { Cloud };

export function isCloud(value: unknown): value is Cloud {
  return typeof value === "string" && (CLOUDS as readonly string[]).includes(value);
}

export function cloudFromCheckId(checkId: string): Cloud {
  return CLOUDS.find((cloud) => checkId.startsWith(`${cloud}-`)) ?? DEFAULT_CLOUD;
}

export function parseCloudQuery(query: Record<string, unknown>): { cloud?: Cloud; error?: string } {
  const raw = query.cloud;
  if (raw === undefined || raw === "") {
    return {};
  }
  if (!isCloud(raw)) {
    return { error: "cloud must be azure or gcp" };
  }
  return { cloud: raw };
}

export function matchesCloud(cloud: Cloud, filter?: Cloud): boolean {
  return filter == null || cloud === filter;
}
