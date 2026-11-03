import { CLOUDS, type Cloud } from "@farside/scan-contracts";

export type { Cloud };

export function isCloud(value: unknown): value is Cloud {
  return typeof value === "string" && (CLOUDS as readonly string[]).includes(value);
}

export function cloudFromCheckId(checkId: string): Cloud {
  return checkId.startsWith("gcp-") ? "gcp" : "azure";
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
