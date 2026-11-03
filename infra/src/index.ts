import { type AccountRegistry, assertDedicatedAccount } from "./account.js";
import { planDevStack } from "./plan.js";
import { PRODUCT_DISPLAY_NAME } from "./product.js";
import { declareStack, type StackInputs } from "./stack.js";

export type StackConfig = {
  customerName: string;
  accountId: string;
  environment: "dev" | "non-prod" | "prod" | "prod-critical";
  callerAccountId: string;
  registry: AccountRegistry;
};

export function planGuardedStack(config: StackConfig) {
  assertDedicatedAccount(
    config.callerAccountId,
    config.accountId,
    config.customerName,
    config.registry,
  );
  return planDevStack({
    customerName: config.customerName,
    environment: config.environment,
    accountId: config.accountId,
  });
}

export function materializeDevStack(config: StackConfig) {
  const plan = planGuardedStack(config);

  return {
    product: PRODUCT_DISPLAY_NAME,
    accountId: plan.accountId,
    address: plan.address,
    healthPath: plan.healthPath,
    resourceNames: plan.resources.map((resource) => resource.name),
    tags: plan.tags,
  };
}

export type DeployInputs = Omit<StackInputs, "plan">;

export function deployStack(config: StackConfig, inputs: DeployInputs) {
  return declareStack({ plan: planGuardedStack(config), ...inputs });
}
