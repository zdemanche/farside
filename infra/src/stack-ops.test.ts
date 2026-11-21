import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAccountRegistry } from "./account.js";

type Recorded = { type: string; name: string; inputs: Record<string, unknown> };

const recorded: Recorded[] = [];
/** Resource registrations and invokes in the order the mocks saw them. */
const order: string[] = [];

const registry = parseAccountRegistry(
  JSON.stringify({
    productDev: { customer: "moonaan-dev", accountId: "123456789012" },
    customers: {},
  }),
);

const config = {
  customerName: "moonaan-dev",
  accountId: "123456789012",
  environment: "dev" as const,
  callerAccountId: "123456789012",
  registry,
};

function ofType(type: string): Recorded[] {
  return recorded.filter((resource) => resource.type === type);
}

async function resolved<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

describe("stack alarms, tick retries and the console invalidation output", () => {
  let outputs: Awaited<ReturnType<typeof deploy>>;

  async function deploy() {
    await pulumi.runtime.setMocks(
      {
        newResource(args) {
          recorded.push({ type: args.type, name: args.name, inputs: args.inputs });
          order.push(`resource:${args.type}:${args.name}`);
          return {
            id: `${args.name}-id`,
            state: {
              ...args.inputs,
              arn: `arn:aws:mock:us-east-2:123456789012:${args.name}`,
              domainName: "d111.cloudfront.net",
              bucketRegionalDomainName: "console.s3.us-east-2.amazonaws.com",
              functionUrl: "https://abc.lambda-url.us-east-2.on.aws/",
            },
          };
        },
        call(args) {
          if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument") {
            return { json: "{}" };
          }
          if (args.token === "aws:index/getRegion:getRegion") {
            return { region: "us-east-2", name: "us-east-2" };
          }
          if (args.token === "aws:kms/getKey:getKey") {
            order.push("invoke:getKey");
            return { arn: "arn:aws:kms:us-east-2:123456789012:key/ssm-mock" };
          }
          return args.inputs;
        },
      },
      "farside",
      "dev",
      false,
    );
    const { deployStack } = await import("./index.js");
    const stack = deployStack(config, {
      apiBundle: "/dist/lambda.mjs",
      tickBundle: "/dist/scheduled.mjs",
      operatorToken: pulumi.secret("operator-token-value"),
      logRetentionDays: 30,
    });
    await pulumi.runtime.disconnect();
    return stack;
  }

  beforeAll(async () => {
    outputs = await deploy();
  });

  it("alarms on tick errors, throttles, long runs and a missing tick, and on API errors", () => {
    const alarms = ofType("aws:cloudwatch/metricAlarm:MetricAlarm");
    const names = alarms.map((alarm) => alarm.name).sort();
    expect(names).toEqual([
      "farside-moonaan-dev-api-errors",
      "farside-moonaan-dev-tick-duration",
      "farside-moonaan-dev-tick-errors",
      "farside-moonaan-dev-tick-missing",
      "farside-moonaan-dev-tick-throttles",
    ]);
    for (const alarm of alarms) {
      expect(alarm.inputs.namespace).toBe("AWS/Lambda");
      expect(alarm.inputs.alarmActions).toHaveLength(1);
    }
  });

  it("treats a missing tick as a breach, and a missing metric elsewhere as healthy", () => {
    const byName = (suffix: string) =>
      ofType("aws:cloudwatch/metricAlarm:MetricAlarm").find((alarm) => alarm.name.endsWith(suffix));
    expect(byName("tick-missing")?.inputs).toMatchObject({
      metricName: "Invocations",
      treatMissingData: "breaching",
      comparisonOperator: "LessThanThreshold",
      period: 1800,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
    });
    expect(byName("tick-errors")?.inputs.treatMissingData).toBe("notBreaching");
  });

  it("watches the tick duration below its 300s timeout", () => {
    const duration = ofType("aws:cloudwatch/metricAlarm:MetricAlarm").find((alarm) =>
      alarm.name.endsWith("tick-duration"),
    );
    expect(duration?.inputs.threshold).toBe(240_000);
    const tick = ofType("aws:lambda/function:Function").find((fn) => fn.name.endsWith("-tick"));
    expect(tick?.inputs.timeout).toBe(300);
  });

  it("makes one alert topic and turns off the tick's Lambda async retries", () => {
    expect(ofType("aws:sns/topic:Topic")).toHaveLength(1);
    const configs = ofType("aws:lambda/functionEventInvokeConfig:FunctionEventInvokeConfig");
    expect(configs).toHaveLength(1);
    expect(configs[0]?.inputs.maximumRetryAttempts).toBe(0);
    expect(configs[0]?.inputs.maximumEventAgeInSeconds).toBe(300);
  });

  it("exports the distribution id and the alert topic", async () => {
    expect(await resolved(outputs.distributionId)).toBeTruthy();
    expect(await resolved(outputs.alertTopicArn)).toContain("alerts");
  });

  it("looks up the AWS-managed ssm key only after the operator-token parameter exists", () => {
    const parameter = order.findIndex(
      (entry) =>
        entry.startsWith("resource:aws:ssm/parameter:Parameter:") &&
        entry.endsWith("-operator-token"),
    );
    const lookup = order.indexOf("invoke:getKey");
    expect(parameter).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(lookup).toBeGreaterThan(parameter);
  });
});
