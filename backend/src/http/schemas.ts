import { ORG_ID_PATTERN } from "../session.js";
import { CLOUDS } from "@farside/scan-contracts";
import { allProviders } from "../providers/index.js";

export const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$";
const ISO_INSTANT_PATTERN = "^\\d{4}-\\d{2}-\\d{2}(T[\\d:.]+(Z|[+-]\\d{2}:\\d{2})?)?$";
const DECIMAL_PATTERN = "^-?\\d+(\\.\\d+)?$";
export const MAX_RECIPIENTS = 20;

const string = (maxLength = 256) => ({ type: "string", minLength: 1, maxLength }) as const;
const instant = { type: "string", pattern: ISO_INSTANT_PATTERN, maxLength: 64 } as const;
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required }) as const;

export const orgParams = object({ orgId: { type: "string", pattern: ORG_ID_PATTERN } }, ["orgId"]);
export const connectionParams = object(
  { orgId: { type: "string", pattern: ORG_ID_PATTERN }, connectionId: string(64) },
  ["orgId", "connectionId"],
);
export const scanParams = object(
  { orgId: { type: "string", pattern: ORG_ID_PATTERN }, scanId: string(64) },
  ["orgId", "scanId"],
);

const cloudParam = { enum: [...CLOUDS, ""] } as const;
export const cloudQuery = object({ cloud: cloudParam });
export const MAX_SCAN_PAGE = 200;
export const DEFAULT_SCAN_PAGE = 50;
export const scansQuery = object({
  cloud: cloudParam,
  limit: { type: "string", pattern: "^[1-9][0-9]{0,5}$" },
  before: string(64),
});
export const exportQuery = object({ cloud: cloudParam, asOf: instant });
export const browseQuery = object({
  cloud: cloudParam,
  owner: { type: "string" },
  service: { type: "string" },
  subscription: { type: "string" },
  region: { type: "string" },
});

export const connectionBody = () =>
  object(
    {
      tenantId: { type: "string", pattern: ID_PATTERN },
      subscriptionId: { type: "string", pattern: ID_PATTERN },
      cloud: { enum: allProviders().map((provider) => provider.cloud) },
      asOf: instant,
    },
    ["tenantId", "subscriptionId"],
  );

export const inventoryBody = object({
  cloud: { type: "string" },
  observedAt: { type: "string" },
  resources: { type: "array" },
});

export const coverageBody = object(
  {
    checkId: string(),
    subscriptionOrProject: string(),
    state: { enum: ["assessed", "unassessed", "undetermined"] },
    causeId: { type: "string" },
    closer: { type: "string" },
  },
  ["checkId", "subscriptionOrProject", "state"],
);

export const scanBody = object({ subscriptionId: { type: "string", pattern: ID_PATTERN } }, [
  "subscriptionId",
]);

export const costHarvestBody = object(
  {
    subscriptionId: { type: "string", pattern: ID_PATTERN },
    agreementType: { type: "string" },
  },
  ["subscriptionId"],
);

export const commitmentHarvestBody = scanBody;

const dailyCostRow = object(
  {
    date: string(32),
    subscriptionId: string(),
    serviceName: string(),
    costAmount: { type: "string", pattern: DECIMAL_PATTERN, maxLength: 32 },
    currency: string(8),
  },
  ["date", "subscriptionId", "serviceName", "costAmount", "currency"],
);

const spendAlert = object(
  {
    id: string(),
    kind: { enum: ["ORG_SPIKE", "SUBSCRIPTION_SPIKE", "SERVICE_SPIKE", "NEW_SERVICE"] },
    date: string(32),
    scope: string(),
    amount: { type: "string", pattern: DECIMAL_PATTERN, maxLength: 32 },
    baseline: { type: "string", pattern: DECIMAL_PATTERN, maxLength: 32 },
    currency: string(8),
    isNew: { type: "boolean" },
  },
  ["id", "kind", "date", "scope", "amount", "baseline", "currency", "isNew"],
);

export const alertsBody = object({
  rows: { type: "array", items: dailyCostRow },
  recipients: {
    type: "array",
    maxItems: MAX_RECIPIENTS,
    items: { type: "string", format: "email", maxLength: 254 },
  },
  previous: { type: "array", items: spendAlert },
  asOf: instant,
});

export const settingsBody = object(
  {
    ownerTagKey: string(),
    productionTagKey: string(),
    productionTagValue: string(),
    snapshotRetentionDays: { type: "integer", minimum: 1 },
    certExpiryFlagDays: { type: "integer", minimum: 1 },
    scanScheduleEnabled: { type: "boolean" },
    scanIntervalHours: { type: "integer", minimum: 1 },
    scanRetryLimit: { type: "integer", minimum: 1 },
    asOf: instant,
  },
  ["ownerTagKey", "productionTagKey", "productionTagValue"],
);

export const contractBody = object(
  {
    plan: string(),
    startDate: instant,
    endDate: { anyOf: [instant, { type: "null" }] },
    unpaidAt: { anyOf: [instant, { type: "null" }] },
    amountDue: { type: "string" },
    currency: { type: "string" },
  },
  ["plan", "startDate"],
);

export const tickBody = object({ now: instant });

export const advanceBody = object({
  event: { enum: ["failed_payment", "paid", "ended"] },
});

export const offboardBody = object({
  confirm: { type: "boolean" },
  exportOffered: { type: "boolean" },
  now: instant,
});
