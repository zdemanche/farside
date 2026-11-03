import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

const INFRA = fileURLToPath(new URL("..", import.meta.url));
const entry = join(INFRA, `.program-smoke-${process.pid}.mjs`);

afterAll(() => rmSync(entry, { force: true }));

const ENTRY = `
import * as pulumi from "@pulumi/pulumi";
const types = [];
await pulumi.runtime.setMocks(
  {
    newResource(args) {
      types.push(args.type);
      return { id: args.name + "-id", state: { ...args.inputs, arn: "arn:aws:mock:us-east-2:123456789012:" + args.name, domainName: "d.cloudfront.net", bucketRegionalDomainName: "b.s3.amazonaws.com", functionUrl: "https://x.lambda-url.us-east-2.on.aws/" } };
    },
    call(args) {
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity") return { accountId: "000000000000" };
      if (args.token === "aws:index/getRegion:getRegion") return { region: "us-east-2", name: "us-east-2" };
      if (args.token === "aws:kms/getKey:getKey") return { arn: "arn:aws:kms:us-east-2:000000000000:key/k" };
      if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument") return { json: "{}" };
      return args.inputs;
    },
  },
  "farside",
  "dev",
  false,
);
const program = await import("./src/program.ts");
await new Promise((resolve) => program.consoleUrl.apply(resolve));
await pulumi.runtime.disconnect();
console.log(JSON.stringify(types));
`;

it("loads src/program.ts the way the Pulumi nodejs runtime does and declares the stack", () => {
  writeFileSync(entry, ENTRY);
  const output = execFileSync("node", ["--import", "tsx", entry], {
    cwd: INFRA,
    encoding: "utf8",
    env: {
      ...process.env,
      PULUMI_CONFIG: JSON.stringify({
        "farside:customerName": "moonaan-dev",
        "farside:accountId": "000000000000",
        "farside:environment": "dev",
        "farside:operatorToken": "operator-token-value",
      }),
      PULUMI_CONFIG_SECRET_KEYS: JSON.stringify(["farside:operatorToken"]),
    },
  });
  const types = JSON.parse(output.trim().split("\n").at(-1) ?? "[]") as string[];
  expect(types).toContain("aws:lambda/function:Function");
  expect(types).toContain("aws:s3/bucket:Bucket");
  expect(types).toContain("aws:scheduler/schedule:Schedule");
});
