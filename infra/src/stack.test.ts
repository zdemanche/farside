import * as pulumi from "@pulumi/pulumi";
import { isRpcSecret, unwrapRpcSecret } from "@pulumi/pulumi/runtime/rpc.js";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAccountRegistry } from "./account.js";
import { planDevStack } from "./plan.js";

type Recorded = { type: string; name: string; inputs: Record<string, unknown> };

const recorded: Recorded[] = [];

const registry = parseAccountRegistry(
  JSON.stringify({ productDev: { customer: "moonaan-dev", accountId: "123456789012" }, customers: {} }),
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

describe("deployStack", () => {
  let outputs: Awaited<ReturnType<typeof deploy>>;

  async function deploy() {
    await pulumi.runtime.setMocks(
      {
        newResource(args) {
          recorded.push({ type: args.type, name: args.name, inputs: args.inputs });
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
          return args.token === "aws:iam/getPolicyDocument:getPolicyDocument"
            ? { json: "{}" }
            : args.inputs;
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
      operatorToken: pulumi.secret("operator-token"),
      logRetentionDays: 30,
    });
    await pulumi.runtime.disconnect();
    return stack;
  }

  beforeAll(async () => {
    outputs = await deploy();
  });

  it("creates the api and scheduled lambdas on Node 22 arm64", () => {
    const functions = ofType("aws:lambda/function:Function");
    expect(functions.map((fn) => fn.name).sort()).toEqual([
      "farside-moonaan-dev-api",
      "farside-moonaan-dev-tick",
    ]);
    for (const fn of functions) {
      expect(fn.inputs.runtime).toBe("nodejs22.x");
      expect(fn.inputs.architectures).toEqual(["arm64"]);
    }
  });

  it("puts the function URL behind AWS_IAM and a CloudFront OAC", () => {
    const urls = ofType("aws:lambda/functionUrl:FunctionUrl");
    expect(urls).toHaveLength(1);
    expect(urls[0]?.inputs.authorizationType).toBe("AWS_IAM");
    const oacs = ofType("aws:cloudfront/originAccessControl:OriginAccessControl");
    expect(oacs.map((oac) => oac.inputs.originAccessControlOriginType).sort()).toEqual(["lambda", "s3"]);
    const permissions = ofType("aws:lambda/permission:Permission");
    expect(permissions.map((permission) => permission.inputs.principal)).toEqual([
      "cloudfront.amazonaws.com",
      "cloudfront.amazonaws.com",
    ]);
  });

  it("keeps the console bucket private", () => {
    expect(ofType("aws:s3/bucket:Bucket")).toHaveLength(1);
    expect(ofType("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock")[0]?.inputs).toMatchObject({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    expect(ofType("aws:cloudfront/distribution:Distribution")).toHaveLength(1);
  });

  it("retains logs and schedules the tick every 15 minutes", () => {
    const groups = ofType("aws:cloudwatch/logGroup:LogGroup");
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.inputs.retentionInDays === 30)).toBe(true);
    const schedules = ofType("aws:scheduler/schedule:Schedule");
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.inputs.scheduleExpression).toBe("rate(15 minutes)");
  });

  it("matches the planned resource names and tags every taggable resource", () => {
    const planned = planDevStack({ customerName: "moonaan-dev", environment: "dev", accountId: "123456789012" });
    const names = new Set(recorded.map((resource) => resource.inputs.name ?? resource.name));
    for (const resource of planned.resources.filter((item) => item.kind !== "iam-role" && item.kind !== "log-group")) {
      const found = [...names].some((name) => String(name).startsWith(resource.name));
      expect(found, resource.name).toBe(true);
    }
    for (const type of ["aws:lambda/function:Function", "aws:s3/bucket:Bucket", "aws:iam/role:Role"]) {
      for (const resource of ofType(type)) {
        expect(resource.inputs.tags, resource.name).toMatchObject({ product: "farside", managedBy: "pulumi" });
      }
    }
  });

  it("passes the operator token as a secret and grants the scheduler only the tick function", async () => {
    const api = ofType("aws:lambda/function:Function").find((fn) => fn.name.endsWith("-api"));
    expect(isRpcSecret(api?.inputs.environment)).toBe(true);
    expect(JSON.stringify(unwrapRpcSecret(api?.inputs.environment))).toContain("FARSIDE_OPERATOR_TOKEN");
    expect(JSON.stringify(api?.inputs.code)).not.toContain("operator-token");
    const invoke = ofType("aws:iam/rolePolicy:RolePolicy").find((policy) => policy.name.endsWith("scheduler-invoke"));
    const policy = JSON.parse(await resolved(pulumi.output(invoke?.inputs.policy as pulumi.Input<string>)));
    expect(policy.Statement).toEqual([
      expect.objectContaining({
        Action: "lambda:InvokeFunction",
        Resource: "arn:aws:mock:us-east-2:123456789012:farside-moonaan-dev-tick",
      }),
    ]);
    expect(await resolved(outputs.healthUrl)).toBe("https://d111.cloudfront.net/health");
  });
});
