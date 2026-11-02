/**
 * Pulumi program for the empty Farside service and console shell.
 *
 * This module is the deploy entry. It is not imported by unit tests. Running
 * `pulumi up` still needs a dedicated AWS account, GitHub OIDC, and the
 * moonaan-pulumi-state backend — see docs/e1-s3-remaining.md.
 *
 * Resource construction stays commented as a typed sketch until that account
 * exists, so `pulumi up` cannot create resources in some other product's
 * account by accident. The plan, tags and account guard are the executable
 * part of this skeleton.
 */
import { assertDedicatedAccount } from "./account.js";
import { planDevStack } from "./plan.js";
import { PRODUCT_DISPLAY_NAME } from "./product.js";

export type StackConfig = {
  customerName: string;
  accountId: string;
  environment: "dev" | "non-prod" | "prod" | "prod-critical";
  callerAccountId: string;
};

export function materializeDevStack(config: StackConfig) {
  assertDedicatedAccount(config.callerAccountId, config.accountId);
  const plan = planDevStack({
    customerName: config.customerName,
    environment: config.environment,
    accountId: config.accountId,
  });

  return {
    product: PRODUCT_DISPLAY_NAME,
    accountId: plan.accountId,
    address: plan.address,
    healthPath: plan.healthPath,
    resourceNames: plan.resources.map((resource) => resource.name),
    tags: plan.tags,
  };
}

/**
 * Pulumi entry used by `infra-pulumi_up.yaml` once AWS credentials exist:
 *
 *   const config = new pulumi.Config("farside");
 *   const identity = aws.getCallerIdentityOutput();
 *   identity.accountId.apply((callerAccountId) => {
 *     const outputs = materializeDevStack({
 *       customerName: config.require("customerName"),
 *       accountId: config.require("accountId"),
 *       environment: config.require("environment"),
 *       callerAccountId,
 *     });
 *     // create lambda (backend/dist), function URL, S3+CloudFront (console/dist)
 *     // with outputs.tags on every resource, then export healthUrl and consoleUrl.
 *   });
 */
export const PULUMI_ENTRY_NOTE =
  "materializeDevStack is the guard; AWS resources are created only after the dedicated account is wired.";
