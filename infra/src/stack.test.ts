import * as pulumi from "@pulumi/pulumi";
import { isRpcSecret } from "@pulumi/pulumi/runtime/rpc.js";
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
          if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument") {
            return { json: "{}" };
          }
          if (args.token === "aws:index/getRegion:getRegion") {
            return { region: "us-east-2", name: "us-east-2" };
          }
          if (args.token === "aws:kms/getKey:getKey") {
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

  it("puts the function URL behind AWS_IAM and keeps it off CloudFront", () => {
    const urls = ofType("aws:lambda/functionUrl:FunctionUrl");
    expect(urls).toHaveLength(1);
    expect(urls[0]?.inputs.authorizationType).toBe("AWS_IAM");
    const oacs = ofType("aws:cloudfront/originAccessControl:OriginAccessControl");
    expect(oacs.map((oac) => oac.inputs.originAccessControlOriginType)).toEqual(["s3"]);
    expect(ofType("aws:lambda/permission:Permission")).toEqual([]);
    const [cdn] = ofType("aws:cloudfront/distribution:Distribution");
    const origins = cdn?.inputs.origins as Array<{ originId: string }>;
    expect(origins.map((origin) => origin.originId)).toEqual(["console"]);
    expect(cdn?.inputs.orderedCacheBehaviors).toBeUndefined();
  });

  it("keeps the console bucket private", () => {
    const buckets = ofType("aws:s3/bucket:Bucket");
    expect(buckets.map((bucket) => bucket.name).sort()).toEqual([
      "farside-moonaan-dev-console",
      "farside-moonaan-dev-store-blobs",
    ]);
    const blocks = ofType("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock");
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.inputs).toMatchObject({
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      });
    }
    expect(ofType("aws:cloudfront/distribution:Distribution")).toHaveLength(1);
  });

  it("retains logs and schedules the tick every 15 minutes", () => {
    const groups = ofType("aws:cloudwatch/logGroup:LogGroup");
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.inputs.retentionInDays === 30)).toBe(true);
    const schedules = ofType("aws:scheduler/schedule:Schedule");
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.inputs.scheduleExpression).toBe("rate(15 minutes)");
    expect(schedules[0]?.inputs.target).toMatchObject({
      retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 300 },
    });
  });

  it("matches the planned resource names and tags every taggable resource", () => {
    const planned = planDevStack({ customerName: "moonaan-dev", environment: "dev", accountId: "123456789012" });
    const names = new Set(recorded.flatMap((resource) => [resource.name, String(resource.inputs.name ?? "")]));
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

  it("creates one on-demand store table with PITR, a keys-only org index and no CMK", () => {
    const tables = ofType("aws:dynamodb/table:Table");
    expect(tables).toHaveLength(1);
    expect(tables[0]?.inputs).toMatchObject({
      name: "farside-moonaan-dev-store",
      billingMode: "PAY_PER_REQUEST",
      hashKey: "pk",
      rangeKey: "sk",
      pointInTimeRecovery: { enabled: true },
      deletionProtectionEnabled: false,
      globalSecondaryIndexes: [{ name: "gsi1", hashKey: "gsi1pk", rangeKey: "gsi1sk", projectionType: "KEYS_ONLY" }],
      tags: { product: "farside", managedBy: "pulumi" },
    });
    expect(tables[0]?.inputs.serverSideEncryption).toBeUndefined();
    expect(tables[0]?.inputs.readCapacity).toBeUndefined();
  });

  it("points both lambdas at the store and grants them only that table and its org index", async () => {
    for (const fn of ofType("aws:lambda/function:Function")) {
      const variables = (fn.inputs.environment as { variables: Record<string, string> }).variables;
      expect(variables.FARSIDE_STORE, fn.name).toBe("dynamo");
      expect(variables.FARSIDE_TABLE_NAME, fn.name).toBe("farside-moonaan-dev-store");
    }
    const grants = ofType("aws:iam/rolePolicy:RolePolicy").filter((policy) => policy.name.endsWith("-store"));
    expect(grants.map((grant) => grant.name).sort()).toEqual(["farside-moonaan-dev-api-store", "farside-moonaan-dev-tick-store"]);
    const table = "arn:aws:mock:us-east-2:123456789012:farside-moonaan-dev-store";
    for (const grant of grants) {
      const policy = JSON.parse(await resolved(pulumi.output(grant.inputs.policy as pulumi.Input<string>)));
      expect(policy.Statement).toEqual([
        {
          Effect: "Allow",
          Action: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:BatchWriteItem",
            "dynamodb:ConditionCheckItem",
            "dynamodb:Query",
          ],
          Resource: table,
        },
        { Effect: "Allow", Action: "dynamodb:Query", Resource: `${table}/index/gsi1` },
      ]);
    }
  });

  it("keeps oversized documents in a private, encrypted blob bucket only the two lambdas can reach", async () => {
    expect(ofType("aws:s3/bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration")[0]?.inputs).toMatchObject({
      rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
    });
    expect(ofType("aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration")[0]?.inputs).toMatchObject({
      rules: [{ status: "Enabled", abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } }],
    });
    expect(ofType("aws:s3/bucketVersioning:BucketVersioning")).toEqual([]);
    for (const fn of ofType("aws:lambda/function:Function")) {
      const variables = (fn.inputs.environment as { variables: Record<string, string> }).variables;
      expect(variables.FARSIDE_BLOB_BUCKET, fn.name).toBe(`farside-moonaan-dev-store-blobs-123456789012`);
    }
    const grants = ofType("aws:iam/rolePolicy:RolePolicy").filter((policy) => policy.name.endsWith("-blobs"));
    expect(grants.map((grant) => grant.name).sort()).toEqual(["farside-moonaan-dev-api-blobs", "farside-moonaan-dev-tick-blobs"]);
    const bucket = "arn:aws:mock:us-east-2:123456789012:farside-moonaan-dev-store-blobs";
    for (const grant of grants) {
      const policy = JSON.parse(await resolved(pulumi.output(grant.inputs.policy as pulumi.Input<string>)));
      expect(policy.Statement).toEqual([
        { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: `${bucket}/ORG#*` },
        { Effect: "Allow", Action: "s3:ListBucket", Resource: bucket },
      ]);
    }
    const [tls] = ofType("aws:s3/bucketPolicy:BucketPolicy").filter((policy) => policy.name.endsWith("store-blobs-policy"));
    const denied = JSON.parse(await resolved(pulumi.output(tls?.inputs.policy as pulumi.Input<string>)));
    expect(denied.Statement).toEqual([
      {
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [bucket, `${bucket}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ]);
  });

  it("keeps the operator token out of the Lambda environment", async () => {
    const api = ofType("aws:lambda/function:Function").find((fn) => fn.name.endsWith("-api"));
    const variables = (api?.inputs.environment as { variables: Record<string, string> }).variables;
    expect(variables.FARSIDE_OPERATOR_TOKEN).toBeUndefined();
    expect(variables.FARSIDE_OPERATOR_TOKEN_PARAM).toBe("/farside/moonaan-dev/operator-token");
    expect(JSON.stringify(api?.inputs)).not.toContain("operator-token-value");
    const [parameter] = ofType("aws:ssm/parameter:Parameter");
    expect(parameter?.inputs.type).toBe("SecureString");
    expect(isRpcSecret(parameter?.inputs.value)).toBe(true);
    const grant = ofType("aws:iam/rolePolicy:RolePolicy").find((policy) => policy.name.endsWith("api-operator-token"));
    const policy = JSON.parse(await resolved(pulumi.output(grant?.inputs.policy as pulumi.Input<string>)));
    expect(policy.Statement).toEqual([
      {
        Effect: "Allow",
        Action: "ssm:GetParameter",
        Resource: "arn:aws:mock:us-east-2:123456789012:farside-moonaan-dev-operator-token",
      },
      {
        Effect: "Allow",
        Action: "kms:Decrypt",
        Resource: "arn:aws:kms:us-east-2:123456789012:key/ssm-mock",
        Condition: { StringEquals: { "kms:ViaService": "ssm.us-east-2.amazonaws.com" } },
      },
    ]);
  });

  it("grants the scheduler only the tick function", async () => {
    const invoke = ofType("aws:iam/rolePolicy:RolePolicy").find((policy) => policy.name.endsWith("scheduler-invoke"));
    const policy = JSON.parse(await resolved(pulumi.output(invoke?.inputs.policy as pulumi.Input<string>)));
    expect(policy.Statement).toEqual([
      expect.objectContaining({
        Action: "lambda:InvokeFunction",
        Resource: "arn:aws:mock:us-east-2:123456789012:farside-moonaan-dev-tick",
      }),
    ]);
    expect(await resolved(outputs.apiUrl)).toBe("https://abc.lambda-url.us-east-2.on.aws/");
    expect(await resolved(outputs.tableName)).toBe("farside-moonaan-dev-store");
  });
});
