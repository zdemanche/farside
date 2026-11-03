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

const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";
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

  const apiLogs = new aws.cloudwatch.LogGroup(`${apiName}-logs`, {
    name: `/aws/lambda/${apiName}`,
    retentionInDays: logRetentionDays,
    tags,
  });
  const api = lambdaFunction({
    name: apiName,
    bundle: apiBundle,
    file: "lambda.mjs",
    handler: "lambda.handler",
    role: lambdaRole(apiName, apiLogs.arn, tags),
    logGroup: apiLogs,
    environment: { ...environment, FARSIDE_OPERATOR_TOKEN: operatorToken },
    timeout: 30,
    tags,
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
  const apiOac = new aws.cloudfront.OriginAccessControl(`${prefix}-api-oac`, {
    originAccessControlOriginType: "lambda",
    signingBehavior: "always",
    signingProtocol: "sigv4",
  });

  const apiBehavior = {
    targetOriginId: "api",
    viewerProtocolPolicy: "https-only",
    allowedMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
    cachedMethods: ["GET", "HEAD"],
    cachePolicyId: CACHING_DISABLED,
    originRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
  };
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
      {
        originId: "api",
        domainName: apiUrl.functionUrl.apply((url) => new URL(url).hostname),
        originAccessControlId: apiOac.id,
        customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: "https-only",
          originSslProtocols: ["TLSv1.2"],
        },
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
    orderedCacheBehaviors: [
      { pathPattern: "/v1/*", ...apiBehavior },
      { pathPattern: plan.healthPath, ...apiBehavior },
    ],
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
  for (const action of ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"]) {
    new aws.lambda.Permission(`${apiName}-cdn-${action.split(":")[1]}`, {
      function: api.name,
      action,
      principal: CLOUDFRONT,
      sourceArn: cdn.arn,
      ...(action === "lambda:InvokeFunctionUrl" ? { functionUrlAuthType: "AWS_IAM" } : {}),
    });
  }

  return {
    consoleUrl: pulumi.interpolate`https://${cdn.domainName}`,
    healthUrl: pulumi.interpolate`https://${cdn.domainName}${plan.healthPath}`,
    consoleBucket: consoleBucket.bucket,
    scheduleName: schedule.name,
  };
}
