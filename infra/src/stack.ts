import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { SCHEDULE_RATE, assertAuthenticatedEdge, type DeployPlan } from "./plan.js";
import { PRODUCT_KEY } from "./product.js";

export type StackInputs = {
  plan: DeployPlan;
  apiBundle: string;
  tickBundle: string;
  operatorToken: pulumi.Input<string>;
  logRetentionDays: number;
};

const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";
const CLOUDFRONT = "cloudfront.amazonaws.com";

function assumeRole(service: string, sourceAccount?: string) {
  return aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        actions: ["sts:AssumeRole"],
        principals: [{ type: "Service", identifiers: [service] }],
        ...(sourceAccount
          ? { conditions: [{ test: "StringEquals", variable: "aws:SourceAccount", values: [sourceAccount] }] }
          : {}),
      },
    ],
  }).json;
}

function lambdaRole(name: string, logGroupArn: pulumi.Input<string>, tags: DeployPlan["tags"]) {
  const role = new aws.iam.Role(`${name}-role`, {
    name: `${name}-role`,
    assumeRolePolicy: assumeRole("lambda.amazonaws.com"),
    tags,
  });
  new aws.iam.RolePolicy(`${name}-logs`, {
    role: role.id,
    policy: pulumi.output(logGroupArn).apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `${arn}:*` },
        ],
      }),
    ),
  });
  return role;
}

function lambdaFunction(input: {
  name: string;
  bundle: string;
  file: string;
  handler: string;
  role: aws.iam.Role;
  logGroup: aws.cloudwatch.LogGroup;
  environment: Record<string, pulumi.Input<string>>;
  timeout: number;
  tags: DeployPlan["tags"];
}) {
  return new aws.lambda.Function(input.name, {
    name: input.name,
    runtime: "nodejs22.x",
    architectures: ["arm64"],
    handler: input.handler,
    role: input.role.arn,
    timeout: input.timeout,
    memorySize: 512,
    code: new pulumi.asset.AssetArchive({ [input.file]: new pulumi.asset.FileAsset(input.bundle) }),
    environment: { variables: input.environment },
    loggingConfig: { logFormat: "JSON", logGroup: input.logGroup.name },
    tags: input.tags,
  });
}

export function declareStack({ plan, apiBundle, tickBundle, operatorToken, logRetentionDays }: StackInputs) {
  assertAuthenticatedEdge(plan);
  const { tags } = plan;
  const prefix = `${PRODUCT_KEY}-${plan.customerName}`;
  const apiName = `${prefix}-api`;
  const tickName = `${prefix}-tick`;
  const environment = { FARSIDE_LOG_LEVEL: "info" };
  const tokenParameter = new aws.ssm.Parameter(`${prefix}-operator-token`, {
    name: `/${PRODUCT_KEY}/${plan.customerName}/operator-token`,
    type: "SecureString",
    value: operatorToken,
    tags,
  });
  const ssmKey = aws.kms.getKeyOutput({ keyId: "alias/aws/ssm" });

  const apiLogs = new aws.cloudwatch.LogGroup(`${apiName}-logs`, {
    name: `/aws/lambda/${apiName}`,
    retentionInDays: logRetentionDays,
    tags,
  });
  const apiRole = lambdaRole(apiName, apiLogs.arn, tags);
  const api = lambdaFunction({
    name: apiName,
    bundle: apiBundle,
    file: "lambda.mjs",
    handler: "lambda.handler",
    role: apiRole,
    logGroup: apiLogs,
    environment: { ...environment, FARSIDE_OPERATOR_TOKEN_PARAM: tokenParameter.name },
    timeout: 30,
    tags,
  });
  new aws.iam.RolePolicy(`${apiName}-operator-token`, {
    role: apiRole.id,
    policy: pulumi.all([tokenParameter.arn, ssmKey.arn]).apply(([parameterArn, keyArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "ssm:GetParameter", Resource: parameterArn },
          { Effect: "Allow", Action: "kms:Decrypt", Resource: keyArn },
        ],
      }),
    ),
  });
  const apiUrl = new aws.lambda.FunctionUrl(`${apiName}-url`, {
    functionName: api.name,
    authorizationType: plan.resources.find((resource) => resource.kind === "lambda-url")?.authType ?? "AWS_IAM",
  });

  const tickLogs = new aws.cloudwatch.LogGroup(`${tickName}-logs`, {
    name: `/aws/lambda/${tickName}`,
    retentionInDays: logRetentionDays,
    tags,
  });
  const tick = lambdaFunction({
    name: tickName,
    bundle: tickBundle,
    file: "scheduled.mjs",
    handler: "scheduled.handler",
    role: lambdaRole(tickName, tickLogs.arn, tags),
    logGroup: tickLogs,
    environment,
    timeout: 300,
    tags,
  });
  const schedulerRole = new aws.iam.Role(`${tickName}-scheduler-role`, {
    name: `${tickName}-scheduler-role`,
    assumeRolePolicy: assumeRole("scheduler.amazonaws.com", plan.accountId),
    tags,
  });
  new aws.iam.RolePolicy(`${tickName}-scheduler-invoke`, {
    role: schedulerRole.id,
    policy: tick.arn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: arn }],
      }),
    ),
  });
  const schedule = new aws.scheduler.Schedule(`${tickName}-schedule`, {
    name: `${tickName}-schedule`,
    scheduleExpression: SCHEDULE_RATE,
    flexibleTimeWindow: { mode: "OFF" },
    target: { arn: tick.arn, roleArn: schedulerRole.arn },
  });

  const consoleBucket = new aws.s3.Bucket(`${prefix}-console`, {
    bucket: `${prefix}-console-${plan.accountId}`,
    forceDestroy: false,
    tags,
  });
  new aws.s3.BucketPublicAccessBlock(`${prefix}-console-public-access`, {
    bucket: consoleBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });
  const bucketOac = new aws.cloudfront.OriginAccessControl(`${prefix}-console-oac`, {
    originAccessControlOriginType: "s3",
    signingBehavior: "always",
    signingProtocol: "sigv4",
  });

  // TODO: #48 route /v1/* here only once a viewer authenticator (Identity) fronts the Function URL; see assertAuthenticatedEdge.
  const cdn = new aws.cloudfront.Distribution(`${prefix}-cdn`, {
    enabled: true,
    defaultRootObject: "index.html",
    httpVersion: "http2and3",
    origins: [
      {
        originId: "console",
        domainName: consoleBucket.bucketRegionalDomainName,
        originAccessControlId: bucketOac.id,
      },
    ],
    defaultCacheBehavior: {
      targetOriginId: "console",
      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: ["GET", "HEAD"],
      cachedMethods: ["GET", "HEAD"],
      cachePolicyId: CACHING_OPTIMIZED,
      compress: true,
    },
    restrictions: { geoRestriction: { restrictionType: "none" } },
    viewerCertificate: { cloudfrontDefaultCertificate: true },
    tags,
  });

  new aws.s3.BucketPolicy(`${prefix}-console-policy`, {
    bucket: consoleBucket.id,
    policy: pulumi.all([consoleBucket.arn, cdn.arn]).apply(([bucketArn, distributionArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: CLOUDFRONT },
            Action: "s3:GetObject",
            Resource: `${bucketArn}/*`,
            Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
          },
        ],
      }),
    ),
  });
  return {
    consoleUrl: pulumi.interpolate`https://${cdn.domainName}`,
    apiUrl: apiUrl.functionUrl,
    consoleBucket: consoleBucket.bucket,
    scheduleName: schedule.name,
  };
}
