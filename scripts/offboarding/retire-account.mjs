#!/usr/bin/env node
/**
 * Retire a customer's dedicated AWS account after offboarding (#182, #178, D8).
 *
 * Runs only after POST /v1/orgs/:orgId/offboard has written a deletion record.
 * Dry run by default. Closing needs all of:
 *   --apply, --confirm <account id> equal to --account-id, an account id that
 *   infra/accounts.json registers to --customer (never product-dev), and a
 *   deletion receipt (GET /v1/orgs/:orgId/deletion JSON) for that org.
 * Credentials come from the Organizations management account. The default
 * client shells out to the AWS CLI; tests inject a fake. No credentials is a
 * clean skip (exit 0).
 *
 *   node scripts/offboarding/retire-account.mjs --customer <slug> --account-id <id> \
 *     --receipt deletion.json [--org <orgId>] [--apply --confirm <id>] [--out record.json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ACCOUNT = /^\d{12}$/;
export const CLOSED_STATES = new Set(["SUSPENDED", "PENDING_CLOSURE", "CLOSED"]);

export function parseArgs(argv) {
  const args = { apply: false };
  const keys = { "--customer": "customer", "--account-id": "accountId", "--receipt": "receipt", "--org": "org", "--confirm": "confirm", "--out": "out" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg in keys) args[keys[arg]] = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

/** Local guards that need no AWS call. Returns problems; empty means the close may proceed. */
export function guard({ customer, accountId, org, receipt, registry, now }) {
  const problems = [];
  if (!customer) problems.push("--customer is required");
  if (!accountId || !ACCOUNT.test(accountId)) problems.push("--account-id must be a 12-digit AWS account id");
  if (registry.productDev?.accountId === accountId || registry.productDev?.customer === customer) {
    problems.push("the product-dev account is never retired by this script");
  } else if (customer && accountId) {
    const registered = Object.hasOwn(registry.customers ?? {}, customer) ? registry.customers[customer] : undefined;
    if (registered !== accountId) {
      problems.push(`account ${accountId} is not the dedicated account registered to ${customer} in infra/accounts.json`);
    }
  }
  if (!receipt) {
    problems.push("--receipt (deletion record JSON) is required: offboard the org first");
  } else {
    const orgId = org ?? customer;
    if (receipt.orgId !== orgId) problems.push(`deletion receipt is for org ${receipt.orgId}, not ${orgId}`);
    if (typeof receipt.deletedAt !== "string" || Number.isNaN(Date.parse(receipt.deletedAt))) {
      problems.push("deletion receipt has no deletedAt");
    } else if (Date.parse(receipt.deletedAt) > Date.parse(now)) {
      problems.push("deletion receipt deletedAt is in the future");
    }
    if (!receipt.rowsPurged || typeof receipt.rowsPurged !== "object") problems.push("deletion receipt has no rowsPurged");
    if (receipt.trigger !== "customer" && receipt.trigger !== "retention") problems.push("deletion receipt trigger must be customer or retention");
    if (receipt.accountClosureAt) problems.push(`deletion receipt already records accountClosureAt ${receipt.accountClosureAt}`);
  }
  return problems;
}

/** AWS CLI-backed Organizations client. Any failure to reach AWS reads as "no credentials". */
export function awsCliClient(exec = (args) => execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) {
  const json = (args) => JSON.parse(exec([...args, "--output", "json"]));
  return {
    async callerAccountId() {
      try {
        return json(["sts", "get-caller-identity"]).Account ?? null;
      } catch {
        return null;
      }
    },
    async describeAccount(accountId) {
      const { Account } = json(["organizations", "describe-account", "--account-id", accountId]);
      return { id: Account.Id, name: Account.Name, status: Account.State ?? Account.Status };
    },
    async closeAccount(accountId) {
      exec(["organizations", "close-account", "--account-id", accountId]);
    },
  };
}

export async function retireAccount({ argv = [], root = ROOT, client = awsCliClient(), now = new Date().toISOString(), receipt: injected } = {}) {
  const args = parseArgs(argv);
  const registry = JSON.parse(readFileSync(join(root, "infra/accounts.json"), "utf8"));
  let receipt = injected ?? null;
  if (!receipt && args.receipt) {
    receipt = JSON.parse(readFileSync(args.receipt, "utf8"));
  }
  const base = {
    kind: "farside-account-retirement/1",
    at: now,
    customer: args.customer ?? null,
    accountId: args.accountId ?? null,
    orgId: args.org ?? args.customer ?? null,
    deletedAt: receipt?.deletedAt ?? null,
  };
  const problems = guard({ ...args, receipt, registry, now });
  if (problems.length > 0) {
    return { ...base, mode: args.apply ? "apply" : "dry-run", status: "refused", problems, accountClosureAt: null, exitCode: 1 };
  }
  if (!args.apply) {
    return {
      ...base,
      mode: "dry-run",
      status: "would-close",
      problems: [],
      accountClosureAt: null,
      reason: `Dry run. Re-run with --apply --confirm ${args.accountId} from the Organizations management account to call CloseAccount.`,
      exitCode: 0,
    };
  }
  if (args.confirm !== args.accountId) {
    return { ...base, mode: "apply", status: "refused", problems: ["--confirm must repeat the account id exactly"], accountClosureAt: null, exitCode: 2 };
  }
  const caller = await client.callerAccountId();
  if (!caller) {
    return {
      ...base,
      mode: "apply",
      status: "skipped",
      problems: [],
      accountClosureAt: null,
      reason: "No AWS credentials for the Organizations management account. Nothing was closed.",
      exitCode: 0,
    };
  }
  if (caller === args.accountId) {
    return { ...base, mode: "apply", status: "refused", problems: ["run from the Organizations management account, not the account being closed"], accountClosureAt: null, exitCode: 1 };
  }
  const account = await client.describeAccount(args.accountId);
  if (account.id !== args.accountId) {
    return { ...base, mode: "apply", status: "refused", problems: [`Organizations returned account ${account.id}`], accountClosureAt: null, exitCode: 1 };
  }
  if (CLOSED_STATES.has(account.status)) {
    return { ...base, mode: "apply", status: "already-closed", accountStatus: account.status, problems: [], accountClosureAt: null, exitCode: 0 };
  }
  await client.closeAccount(args.accountId);
  return {
    ...base,
    mode: "apply",
    status: "closed",
    accountName: account.name,
    callerAccountId: caller,
    problems: [],
    accountClosureAt: now,
    reason: "CloseAccount accepted. The account is SUSPENDED for 90 days, then closed by AWS. Remove it from infra/accounts.json in a PR.",
    exitCode: 0,
  };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  try {
    const argv = process.argv.slice(2);
    const record = await retireAccount({ argv });
    const { exitCode, ...rest } = record;
    console.log(rest.reason ?? rest.status);
    for (const problem of rest.problems) console.log(`  ${problem}`);
    const out = parseArgs(argv).out;
    if (out && rest.status !== "refused") {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(rest, null, 2)}\n`);
      console.log(`record written to ${out}`);
    }
    process.exit(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
