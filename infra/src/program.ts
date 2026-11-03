import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { resolve } from "node:path";
import { loadAccountRegistry } from "./account.js";
import { deployStack, type StackConfig } from "./index.js";

const ENVIRONMENTS = ["dev", "non-prod", "prod", "prod-critical"] as const;

const config = new pulumi.Config("farside");
const registry = loadAccountRegistry(resolve("accounts.json"));
const bundleDir = resolve("..", "backend", "dist");

const environment = config.require("environment");
if (!ENVIRONMENTS.includes(environment as StackConfig["environment"])) {
  throw new Error(`farside:environment must be one of ${ENVIRONMENTS.join(", ")}`);
}

// Resources are declared inside apply on purpose: the account guard in deployStack must run before any of them.
const outputs = aws.getCallerIdentityOutput().accountId.apply((callerAccountId) => {
  const stack: StackConfig = {
    customerName: config.require("customerName"),
    accountId: config.require("accountId"),
    environment: environment as StackConfig["environment"],
    callerAccountId,
    registry,
  };
  return deployStack(stack, {
    apiBundle: resolve(bundleDir, "lambda.mjs"),
    tickBundle: resolve(bundleDir, "scheduled.mjs"),
    operatorToken: config.requireSecret("operatorToken"),
    logRetentionDays: config.getNumber("logRetentionDays") ?? 30,
  });
});

export const consoleUrl = outputs.consoleUrl;
export const apiUrl = outputs.apiUrl;
export const consoleBucket = outputs.consoleBucket;
export const scheduleName = outputs.scheduleName;
