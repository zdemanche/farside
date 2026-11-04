export type OrgSettings = {
  ownerTagKey: string;
  productionTagKey: string;
  productionTagValue: string;
  snapshotRetentionDays: number;
  certExpiryFlagDays: number;
  scanScheduleEnabled: boolean;
  scanIntervalHours: number;
  scanRetryLimit: number;
  alertRecipients: readonly string[];
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
  alertRecipients: [],
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export type SettingsInput = Pick<
  OrgSettings,
  "ownerTagKey" | "productionTagKey" | "productionTagValue"
> &
  Partial<Omit<OrgSettings, "updatedAt">>;

export function settingsFromInput(input: SettingsInput): Omit<OrgSettings, "updatedAt"> {
  return {
    ownerTagKey: input.ownerTagKey,
    productionTagKey: input.productionTagKey,
    productionTagValue: input.productionTagValue,
    snapshotRetentionDays: input.snapshotRetentionDays ?? DEFAULT_SETTINGS.snapshotRetentionDays,
    certExpiryFlagDays: input.certExpiryFlagDays ?? DEFAULT_SETTINGS.certExpiryFlagDays,
    scanScheduleEnabled: input.scanScheduleEnabled ?? DEFAULT_SETTINGS.scanScheduleEnabled,
    scanIntervalHours: input.scanIntervalHours ?? DEFAULT_SETTINGS.scanIntervalHours,
    scanRetryLimit: input.scanRetryLimit ?? DEFAULT_SETTINGS.scanRetryLimit,
    alertRecipients: input.alertRecipients ?? [...DEFAULT_SETTINGS.alertRecipients],
  };
}
