import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../backend/src/app.ts";
import { MemoryStore } from "../../backend/src/store.ts";
import { awsCliClient, guard, parseArgs, retireAccount } from "./retire-account.mjs";

const NOW = "2026-11-09T12:00:00.000Z";
const ACCOUNT = "000000000001";
const CUSTOMER = "example-customer";
let receipt;
let app;

beforeAll(async () => {
  app = buildApp(new MemoryStore(() => "2026-11-09T10:00:00.000Z"), { clock: () => "2026-11-09T10:00:00.000Z" });
  const headers = { "x-farside-org": CUSTOMER, "x-farside-actor": "cto" };
  await app.inject({ method: "PUT", url: `/v1/orgs/${CUSTOMER}/settings`, headers, payload: { scanIntervalHours: 24 } });
  const offboard = await app.inject({
    method: "POST",
    url: `/v1/orgs/${CUSTOMER}/offboard`,
    headers,
    payload: { confirm: true, exportOffered: true },
  });
  expect(offboard.statusCode).toBe(200);
  const deletion = await app.inject({ method: "GET", url: `/v1/orgs/${CUSTOMER}/deletion`, headers });
  receipt = deletion.json();
});

afterAll(async () => {
  await app.close();
});

function fakeOrganizations({ caller = "999999999999", status = "ACTIVE" } = {}) {
  const closed = [];
  return {
    closed,
    async callerAccountId() {
      return caller;
    },
    async describeAccount(id) {
      return { id, name: `farside-${CUSTOMER}`, status };
    },
    async closeAccount(id) {
      closed.push(id);
    },
  };
}

const argv = (...extra) => ["--customer", CUSTOMER, "--account-id", ACCOUNT, ...extra];

describe("account retirement guards", () => {
  it("uses a real deletion receipt from the offboard API", () => {
    expect(receipt).toMatchObject({ orgId: CUSTOMER, trigger: "customer", accountClosureAt: null });
  });

  it("dry run closes nothing and says what it would do", async () => {
    const client = fakeOrganizations();
    const record = await retireAccount({ argv: argv(), receipt, client, now: NOW });
    expect(record).toMatchObject({ mode: "dry-run", status: "would-close", exitCode: 0 });
    expect(client.closed).toEqual([]);
  });

  it("refuses without a deletion receipt", async () => {
    const client = fakeOrganizations();
    const record = await retireAccount({ argv: argv("--apply", "--confirm", ACCOUNT), client, now: NOW });
    expect(record.status).toBe("refused");
    expect(record.problems.join(" ")).toMatch(/offboard the org first/);
    expect(client.closed).toEqual([]);
  });

  it("refuses an account not registered to the customer, and product-dev", async () => {
    const registry = { productDev: { customer: "moonaan-dev", accountId: "000000000000" }, customers: { [CUSTOMER]: ACCOUNT } };
    expect(guard({ customer: CUSTOMER, accountId: "123456789012", receipt, registry, now: NOW }).join(" ")).toMatch(/not the dedicated account/);
    expect(guard({ customer: "moonaan-dev", accountId: "000000000000", receipt, registry, now: NOW }).join(" ")).toMatch(/product-dev/);
    expect(guard({ customer: CUSTOMER, accountId: "12", receipt, registry, now: NOW }).join(" ")).toMatch(/12-digit/);
  });

  it("refuses a receipt for another org, from the future, or already retired", () => {
    const registry = { productDev: { customer: "moonaan-dev", accountId: "000000000000" }, customers: { [CUSTOMER]: ACCOUNT } };
    const check = (patch, org) => guard({ customer: CUSTOMER, accountId: ACCOUNT, org, receipt: { ...receipt, ...patch }, registry, now: NOW }).join(" ");
    expect(check({}, "other-org")).toMatch(/not other-org/);
    expect(check({ deletedAt: "2027-01-01T00:00:00.000Z" })).toMatch(/future/);
    expect(check({ accountClosureAt: NOW })).toMatch(/already records/);
    expect(check({ trigger: "manual" })).toMatch(/trigger/);
  });

  it("refuses apply unless --confirm repeats the account id", async () => {
    const client = fakeOrganizations();
    const missing = await retireAccount({ argv: argv("--apply"), receipt, client, now: NOW });
    const wrong = await retireAccount({ argv: argv("--apply", "--confirm", "000000000002"), receipt, client, now: NOW });
    expect(missing.exitCode).toBe(2);
    expect(wrong.exitCode).toBe(2);
    expect(client.closed).toEqual([]);
  });
});

describe("account retirement apply", () => {
  it("skips with exit 0 when there are no AWS credentials", async () => {
    const client = { ...fakeOrganizations(), callerAccountId: async () => null };
    const record = await retireAccount({ argv: argv("--apply", "--confirm", ACCOUNT), receipt, client, now: NOW });
    expect(record).toMatchObject({ status: "skipped", exitCode: 0, accountClosureAt: null });
  });

  it("refuses to run from inside the account being closed", async () => {
    const client = fakeOrganizations({ caller: ACCOUNT });
    const record = await retireAccount({ argv: argv("--apply", "--confirm", ACCOUNT), receipt, client, now: NOW });
    expect(record.status).toBe("refused");
    expect(client.closed).toEqual([]);
  });

  it("closes the account and records accountClosureAt", async () => {
    const client = fakeOrganizations();
    const record = await retireAccount({ argv: argv("--apply", "--confirm", ACCOUNT), receipt, client, now: NOW });
    expect(record).toMatchObject({ status: "closed", accountClosureAt: NOW, deletedAt: receipt.deletedAt, exitCode: 0 });
    expect(client.closed).toEqual([ACCOUNT]);
  });

  it("is idempotent for an account already suspended", async () => {
    const client = fakeOrganizations({ status: "SUSPENDED" });
    const record = await retireAccount({ argv: argv("--apply", "--confirm", ACCOUNT), receipt, client, now: NOW });
    expect(record.status).toBe("already-closed");
    expect(client.closed).toEqual([]);
  });

  it("drives the AWS CLI with the expected commands", async () => {
    const calls = [];
    const exec = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "sts") return JSON.stringify({ Account: "999999999999" });
      if (args[1] === "describe-account") return JSON.stringify({ Account: { Id: ACCOUNT, Name: "n", State: "ACTIVE" } });
      return "";
    };
    const client = awsCliClient(exec);
    expect(await client.callerAccountId()).toBe("999999999999");
    expect(await client.describeAccount(ACCOUNT)).toEqual({ id: ACCOUNT, name: "n", status: "ACTIVE" });
    await client.closeAccount(ACCOUNT);
    expect(calls.at(-1)).toBe(`organizations close-account --account-id ${ACCOUNT}`);
    const offline = awsCliClient(() => {
      throw new Error("Unable to locate credentials");
    });
    expect(await offline.callerAccountId()).toBeNull();
  });

  it("parses flags", () => {
    expect(parseArgs(argv("--apply", "--confirm", ACCOUNT))).toMatchObject({ apply: true, confirm: ACCOUNT, customer: CUSTOMER });
    expect(() => parseArgs(["--force"])).toThrow(/unknown/);
  });
});
