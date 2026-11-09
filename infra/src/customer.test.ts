import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SharedAccountError, loadAccountRegistry, parseAccountRegistry } from "./account.js";
import { runCustomerCli } from "./customer-cli.js";
import { customerStack, loadCustomerCatalogue, parseCustomerCatalogue, renderStackYaml } from "./customer.js";

const INFRA = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(INFRA, "..");
const registry = parseAccountRegistry(
  JSON.stringify({
    productDev: { customer: "moonaan-dev", accountId: "100000000000" },
    customers: { acme: "123456789012", globex: "222222222222" },
  }),
);
const catalogue = parseCustomerCatalogue(
  JSON.stringify({ acme: { environment: "prod", region: "us-east-2", logRetentionDays: 30 }, globex: { environment: "non-prod", region: "eu-west-1" } }),
);

describe("customer stack config", () => {
  it("parameterises one customer with key, account and D5 address", () => {
    const stack = customerStack("acme", "123456789012", catalogue, registry);
    expect(stack.stackName).toBe("organization/farside/acme");
    expect(stack.address).toBe("farside.acme.moonaan.com");
    expect(stack.config).toEqual({
      "aws:region": "us-east-2",
      "farside:customerName": "acme",
      "farside:accountId": "123456789012",
      "farside:environment": "prod",
      "farside:address": "farside.acme.moonaan.com",
      "farside:logRetentionDays": "30",
    });
    const yaml = renderStackYaml(stack);
    expect(yaml).toContain('  farside:accountId: "123456789012"');
    expect(yaml).not.toContain("operatorToken");
  });

  it("refuses an account registered to another customer or not registered", () => {
    expect(() => customerStack("acme", "222222222222", catalogue, registry)).toThrow(SharedAccountError);
    expect(() => customerStack("initech", "333333333333", catalogue, registry)).toThrow(SharedAccountError);
  });

  it("refuses a registered customer with no deploy parameters", () => {
    expect(() => customerStack("moonaan-dev", "100000000000", catalogue, registry)).toThrow(/customers.json/);
  });

  it("rejects bad catalogue entries", () => {
    expect(() => parseCustomerCatalogue('{"Acme":{"environment":"prod","region":"us-east-2"}}')).toThrow(/tenant slug/);
    expect(() => parseCustomerCatalogue('{"acme":{"environment":"live","region":"us-east-2"}}')).toThrow(/environment/);
    expect(() => parseCustomerCatalogue('{"acme":{"environment":"prod","region":"ohio"}}')).toThrow(/region/);
    expect(() => parseCustomerCatalogue('{"acme":{"environment":"prod","region":"us-east-2","logRetentionDays":0}}')).toThrow(
      /logRetentionDays/,
    );
  });

  it("covers every registered account in the committed catalogue", () => {
    const committed = loadCustomerCatalogue(join(INFRA, "customers.json"));
    const accounts = loadAccountRegistry(join(INFRA, "accounts.json"));
    for (const slug of [accounts.productDev.customer, ...Object.keys(accounts.customers)]) {
      expect(committed[slug], slug).toBeDefined();
    }
  });
});

describe("customer-cli", () => {
  it("prints the stack without writing in dry run and writes Pulumi.<slug>.yaml with --write", () => {
    const dir = mkdtempSync(join(tmpdir(), "farside-customer-"));
    writeFileSync(join(dir, "accounts.json"), JSON.stringify({ productDev: { customer: "moonaan-dev", accountId: "100000000000" }, customers: { acme: "123456789012" } }));
    writeFileSync(join(dir, "customers.json"), JSON.stringify({ acme: { environment: "prod", region: "us-east-2" } }));
    const dry = runCustomerCli(["--customer", "acme", "--account", "123456789012"], dir);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.output).file).toBeNull();
    const written = runCustomerCli(["--customer", "acme", "--account", "123456789012", "--write"], dir);
    expect(written.code).toBe(0);
    expect(readFileSync(join(dir, "Pulumi.acme.yaml"), "utf8")).toContain('farside:address: "farside.acme.moonaan.com"');
    expect(runCustomerCli(["--customer", "acme", "--account", "999999999999"], dir).code).toBe(1);
    expect(runCustomerCli(["--customer", "acme"], dir).code).toBe(2);
  });
});

describe("deploy-customer workflow", () => {
  const text = readFileSync(join(ROOT, ".github/workflows/deploy-customer.yml"), "utf8");

  it("is dispatch-only, main-only and needs no iac-hub", () => {
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(text).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(text).toContain('if [ "$REF" != "refs/heads/main" ]');
    expect(text).not.toMatch(/run_identifier|adoptingProducts|repository_dispatch/);
  });

  it("skips every AWS step when credentials are absent", () => {
    expect(text).toContain('echo "enabled=false" >> "$GITHUB_OUTPUT"');
    const awsSteps = text.split("\n      - ").filter((step) => /configure-aws-credentials|pulumi\/actions|pulumi up|aws s3 sync/.test(step));
    expect(awsSteps.length).toBe(4);
    for (const step of awsSteps) {
      expect(step).toContain("steps.creds.outputs.enabled == 'true'");
    }
  });

  it("builds stack config from main through customer-cli", () => {
    expect(text).toContain("git show origin/main:infra/accounts.json");
    expect(text).toContain("git show origin/main:infra/customers.json");
    expect(text).toContain("src/customer-cli.ts");
  });
});
