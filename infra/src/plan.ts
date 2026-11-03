import { moonaanTags, type FarsideTagInput, type FarsideTags } from "./tags.js";
import { HEALTH_PATH, PRODUCT_KEY, customerAddress } from "./product.js";

export type FunctionUrlAuthType = "AWS_IAM" | "NONE";

export type EdgeBehavior = {
  pathPattern: string;
  origin: "console" | "api";
  signedToOrigin: boolean;
};

export type ViewerAuthenticator = "edge-function" | "waf" | "signed-cookies";

export type PlannedResource = {
  name: string;
  kind:
    | "iam-role"
    | "ssm-parameter"
    | "lambda"
    | "lambda-url"
    | "log-group"
    | "scheduler-schedule"
    | "s3-bucket"
    | "cloudfront";
  tags: FarsideTags;
  authType?: FunctionUrlAuthType;
  behaviors?: EdgeBehavior[];
  viewerAuthenticator?: ViewerAuthenticator;
};

export type DeployPlan = {
  product: typeof PRODUCT_KEY;
  customerName: string;
  accountId: string;
  address: string;
  healthPath: typeof HEALTH_PATH;
  servesV1: boolean;
  tags: FarsideTags;
  resources: PlannedResource[];
};

export class PublicApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicApiError";
  }
}

export const SCHEDULE_RATE = "rate(15 minutes)";

export function planDevStack(input: FarsideTagInput & { accountId: string }): DeployPlan {
  const tags = moonaanTags(input);
  const prefix = `${PRODUCT_KEY}-${input.customerName}`;
  const resources: PlannedResource[] = [
    { name: `${prefix}-api-role`, kind: "iam-role", tags },
    { name: `${prefix}-operator-token`, kind: "ssm-parameter", tags },
    { name: `${prefix}-api-logs`, kind: "log-group", tags },
    { name: `${prefix}-api`, kind: "lambda", tags },
    { name: `${prefix}-api-url`, kind: "lambda-url", tags, authType: "AWS_IAM" },
    { name: `${prefix}-tick-role`, kind: "iam-role", tags },
    { name: `${prefix}-tick-logs`, kind: "log-group", tags },
    { name: `${prefix}-tick`, kind: "lambda", tags },
    { name: `${prefix}-tick-scheduler-role`, kind: "iam-role", tags },
    { name: `${prefix}-tick-schedule`, kind: "scheduler-schedule", tags },
    { name: `${prefix}-console`, kind: "s3-bucket", tags },
    {
      name: `${prefix}-cdn`,
      kind: "cloudfront",
      tags,
      behaviors: [{ pathPattern: "*", origin: "console", signedToOrigin: true }],
    },
  ];

  const plan: DeployPlan = {
    product: PRODUCT_KEY,
    customerName: input.customerName,
    accountId: input.accountId,
    address: customerAddress(input.customerName),
    healthPath: HEALTH_PATH,
    servesV1: true,
    tags,
    resources,
  };
  assertAuthenticatedEdge(plan);
  return plan;
}

export function assertAuthenticatedEdge(plan: DeployPlan): void {
  if (!plan.servesV1) {
    return;
  }
  const open = plan.resources.filter(
    (resource) => resource.kind === "lambda-url" && resource.authType !== "AWS_IAM",
  );
  if (open.length > 0) {
    throw new PublicApiError(
      `Function URL ${open.map((resource) => resource.name).join(", ")} serves /v1 without AWS_IAM auth.`,
    );
  }
  const unauthenticated = plan.resources.filter(
    (resource) =>
      resource.kind === "cloudfront" &&
      !resource.viewerAuthenticator &&
      (resource.behaviors ?? []).some((behavior) => behavior.origin === "api"),
  );
  if (unauthenticated.length > 0) {
    throw new PublicApiError(
      `CloudFront ${unauthenticated.map((resource) => resource.name).join(", ")} routes API paths to the Function URL without a viewer authenticator.`,
    );
  }
}

export function untaggedResources(plan: DeployPlan): PlannedResource[] {
  return plan.resources.filter((resource) => resource.tags !== plan.tags);
}
