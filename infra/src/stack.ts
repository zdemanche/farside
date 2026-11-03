import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import {
  CDN_BEHAVIORS,
  SCHEDULE_RATE,
  assertAuthenticatedEdge,
  storeDeletionProtection,
  type DeployPlan,
} from "./plan.js";
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
const ORG_INDEX = "gsi1";
const BLOB_PREFIX = "ORG#";
const TABLE_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
  "dynamodb:DeleteItem",
  "dynamodb:BatchWriteItem",
  "dynamodb:ConditionCheckItem",
  "dynamodb:Query",
];

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

function grantTable(name: string, role: aws.iam.Role, tableArn: pulumi.Input<string>) {
  new aws.iam.RolePolicy(`${name}-store`, {
    role: role.id,
    policy: pulumi.output(tableArn).apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: TABLE_ACTIONS, Resource: arn },
          { Effect: "Allow", Action: "dynamodb:Query", Resource: `${arn}/index/${ORG_INDEX}` },
        ],
      }),
    ),
  });
}

function grantBlobs(name: string, role: aws.iam.Role, bucketArn: pulumi.Input<string>) {
  new aws.iam.RolePolicy(`${name}-blobs`, {
    role: role.id,
    policy: pulumi.output(bucketArn).apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            Resource: `${arn}/${BLOB_PREFIX}*`,
          },
          // Unconditional ListBucket: dedicated Farside bucket, all objects under ORG#; the role already has Get/Delete on ORG#*, so listing exposes nothing new; an s3:prefix condition makes missing keys return 403 and breaks blob re-read (#278)
          { Effect: "Allow", Action: "s3:ListBucket", Resource: arn },
        ],
      }),
    ),
  });
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
  const store = new aws.dynamodb.Table(`${prefix}-store`, {
    name: `${prefix}-store`,
    billingMode: "PAY_PER_REQUEST",
    hashKey: "pk",
    rangeKey: "sk",
    attributes: [
      { name: "pk", type: "S" },
      { name: "sk", type: "S" },
      { name: "gsi1pk", type: "S" },
      { name: "gsi1sk", type: "S" },
    ],
    globalSecondaryIndexes: [
      { name: ORG_INDEX, hashKey: "gsi1pk", rangeKey: "gsi1sk", projectionType: "KEYS_ONLY" },
    ],
    pointInTimeRecovery: { enabled: true },
    deletionProtectionEnabled: storeDeletionProtection(tags.environment),
    tags,
  });
  const blobs = new aws.s3.Bucket(`${prefix}-store-blobs`, {
    bucket: `${prefix}-store-blobs-${plan.accountId}`,
    forceDestroy: false,
    tags,
  });
  new aws.s3.BucketPublicAccessBlock(`${prefix}-store-blobs-public-access`, {
    bucket: blobs.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });
  new aws.s3.BucketServerSideEncryptionConfiguration(`${prefix}-store-blobs-encryption`, {
    bucket: blobs.id,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
  });
  new aws.s3.BucketPolicy(`${prefix}-store-blobs-policy`, {
    bucket: blobs.id,
    policy: blobs.arn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [arn, `${arn}/*`],
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          },
        ],
      }),
    ),
  });
  new aws.s3.BucketLifecycleConfiguration(`${prefix}-store-blobs-lifecycle`, {
    bucket: blobs.id,
    rules: [{ id: "abort-incomplete-multipart", status: "Enabled", abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } }],
  });
  const environment = {
    FARSIDE_LOG_LEVEL: "info",
    FARSIDE_STORE: "dynamo",
    FARSIDE_TABLE_NAME: store.name,
    FARSIDE_BLOB_BUCKET: blobs.bucket,
  };
  const tokenParameter = new aws.ssm.Parameter(`${prefix}-operator-token`, {
    name: `/${PRODUCT_KEY}/${plan.customerName}/operator-token`,
    type: "SecureString",
    value: operatorToken,
    tags,
  });
  const ssmKey = aws.kms.getKeyOutput({ keyId: "alias/aws/ssm" });
  const region = aws.getRegionOutput().region;

  const apiLogs = new aws.cloudwatch.LogGroup(`${apiName}-logs`, {
    name: `/aws/lambda/${apiName}`,
    retentionInDays: logRetentionDays,
    tags,
  });
  const apiRole = lambdaRole(apiName, apiLogs.arn, tags);
  grantTable(apiName, apiRole, store.arn);
  grantBlobs(apiName, apiRole, blobs.arn);
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
    policy: pulumi.all([tokenParameter.arn, ssmKey.arn, region]).apply(([parameterArn, keyArn, regionName]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "ssm:GetParameter", Resource: parameterArn },
          {
            Effect: "Allow",
            Action: "kms:Decrypt",
            Resource: keyArn,
            Condition: { StringEquals: { "kms:ViaService": `ssm.${regionName}.amazonaws.com` } },
          },
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
  const tickRole = lambdaRole(tickName, tickLogs.arn, tags);
  grantTable(tickName, tickRole, store.arn);
  grantBlobs(tickName, tickRole, blobs.arn);
  const tick = lambdaFunction({
    name: tickName,
    bundle: tickBundle,
    file: "scheduled.mjs",
    handler: "scheduled.handler",
    role: tickRole,
    logGroup: tickLogs,
    environment: { ...environment, FARSIDE_EMIT_EMF: "1" },
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
    target: {
      arn: tick.arn,
      roleArn: schedulerRole.arn,
      retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 300 },
    },
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
      targetOriginId: CDN_BEHAVIORS.find((behavior) => behavior.pathPattern === "*")?.origin ?? "console",
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
    tableName: store.name,
  };
}
