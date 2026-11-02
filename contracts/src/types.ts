export const CLOUDS = ["azure", "gcp"] as const;
export type Cloud = (typeof CLOUDS)[number];

export const FINDING_RESULTS = ["pass", "fail", "undetermined"] as const;
export type FindingResult = (typeof FINDING_RESULTS)[number];

/** Decimal strings, never a JSON number. Range only — a point value is invalid. */
export type SavingsRange = {
  min: string;
  max: string;
  currency: string;
};

export type Evidence = {
  fields: Record<string, string | number | boolean | null>;
};

export type FindingScope = {
  id: string;
  cloud: Cloud;
  subscriptionOrProject: string;
};

export type Finding = {
  checkId: string;
  result: FindingResult;
  evidence: Evidence;
  scope: FindingScope;
  closer?: string;
  savings?: SavingsRange;
};

export type InventoryRecord = {
  resourceUri: string;
  resourceType: string;
  region: string;
  displayName: string;
  tags: Record<string, string>;
  ownerTag?: string | null;
};

export type Inventory = {
  cloud: Cloud;
  observedAt: string;
  resources: InventoryRecord[];
};

export type CoverageScope = {
  id: string;
  checkId: string;
  assessed: boolean;
};

export type Coverage = {
  scopes: CoverageScope[];
};

export type CheckSpec = {
  id: string;
  title: string;
  cloud: Cloud;
};

export const RAW_PROVIDER_KEYS = [
  "raw",
  "payload",
  "providerPayload",
  "sdkResponse",
  "armBody",
  "originalResponse",
  "gcpResource",
] as const;
