export type OrgSettings = {
  ownerTagKey: string;
  productionTagKey: string;
  productionTagValue: string;
  snapshotRetentionDays: number;
  certExpiryFlagDays: number;
  scanScheduleEnabled: boolean;
  scanIntervalHours: number;
  scanRetryLimit: number;
  updatedAt: string;
};

export const DEFAULT_SETTINGS: OrgSettings = {
  ownerTagKey: "owner",
  productionTagKey: "environment",
  productionTagValue: "prod",
  snapshotRetentionDays: 30,
  certExpiryFlagDays: 60,
  scanScheduleEnabled: true,
  scanIntervalHours: 24,
  scanRetryLimit: 3,
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
  const snapshotRetentionDays =
    typeof record.snapshotRetentionDays === "number" && record.snapshotRetentionDays > 0
      ? record.snapshotRetentionDays
      : DEFAULT_SETTINGS.snapshotRetentionDays;
  const certExpiryFlagDays =
    typeof record.certExpiryFlagDays === "number" && record.certExpiryFlagDays > 0
      ? record.certExpiryFlagDays
      : DEFAULT_SETTINGS.certExpiryFlagDays;
  const scanIntervalHours =
    typeof record.scanIntervalHours === "number" && record.scanIntervalHours > 0
      ? record.scanIntervalHours
      : DEFAULT_SETTINGS.scanIntervalHours;
  const scanRetryLimit =
    typeof record.scanRetryLimit === "number" && record.scanRetryLimit > 0
      ? record.scanRetryLimit
      : DEFAULT_SETTINGS.scanRetryLimit;
  return {
    ownerTagKey: record.ownerTagKey,
    productionTagKey: record.productionTagKey,
    productionTagValue: record.productionTagValue,
    snapshotRetentionDays,
    certExpiryFlagDays,
    scanScheduleEnabled:
      typeof record.scanScheduleEnabled === "boolean"
        ? record.scanScheduleEnabled
        : DEFAULT_SETTINGS.scanScheduleEnabled,
    scanIntervalHours,
    scanRetryLimit,
  };
}
