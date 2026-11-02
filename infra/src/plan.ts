import { moonaanTags, type FarsideTagInput, type FarsideTags } from "./tags.js";
import { HEALTH_PATH, PRODUCT_KEY, customerAddress } from "./product.js";

export type PlannedResource = {
  name: string;
  kind: "lambda" | "lambda-url" | "iam-role" | "s3-bucket" | "cloudfront" | "dns-record";
  tags: FarsideTags;
};

export type DeployPlan = {
  product: typeof PRODUCT_KEY;
  customerName: string;
  accountId: string;
  address: string;
  healthPath: typeof HEALTH_PATH;
  tags: FarsideTags;
  resources: PlannedResource[];
};

export function planDevStack(input: FarsideTagInput & { accountId: string }): DeployPlan {
  const tags = moonaanTags(input);
  const resources: PlannedResource[] = [
    { name: `${PRODUCT_KEY}-${input.customerName}-health-role`, kind: "iam-role", tags },
    { name: `${PRODUCT_KEY}-${input.customerName}-health`, kind: "lambda", tags },
    { name: `${PRODUCT_KEY}-${input.customerName}-health-url`, kind: "lambda-url", tags },
    { name: `${PRODUCT_KEY}-${input.customerName}-console`, kind: "s3-bucket", tags },
    { name: `${PRODUCT_KEY}-${input.customerName}-console-cdn`, kind: "cloudfront", tags },
    { name: `${PRODUCT_KEY}-${input.customerName}-dns`, kind: "dns-record", tags },
  ];

  return {
    product: PRODUCT_KEY,
    customerName: input.customerName,
    accountId: input.accountId,
    address: customerAddress(input.customerName),
    healthPath: HEALTH_PATH,
    tags,
    resources,
  };
}

export function untaggedResources(plan: DeployPlan): PlannedResource[] {
  return plan.resources.filter((resource) => resource.tags !== plan.tags);
}
