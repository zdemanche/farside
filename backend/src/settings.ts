export type OrgSettings = {
  ownerTagKey: string;
  productionTagKey: string;
  productionTagValue: string;
  updatedAt: string;
};

export const DEFAULT_SETTINGS: OrgSettings = {
  ownerTagKey: "owner",
  productionTagKey: "environment",
  productionTagValue: "prod",
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export function parseSettings(body: unknown): Omit<OrgSettings, "updatedAt"> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.ownerTagKey !== "string" || record.ownerTagKey.length === 0) {
    return null;
  }
  if (typeof record.productionTagKey !== "string" || record.productionTagKey.length === 0) {
    return null;
  }
  if (typeof record.productionTagValue !== "string" || record.productionTagValue.length === 0) {
    return null;
  }
  return {
    ownerTagKey: record.ownerTagKey,
    productionTagKey: record.productionTagKey,
    productionTagValue: record.productionTagValue,
  };
}
