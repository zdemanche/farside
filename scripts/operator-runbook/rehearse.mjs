#!/usr/bin/env node
/**
 * Sale-to-first-scan rehearsal (#176). Walks docs/operator-runbook.md steps in
 * order, checks each step's preconditions, and writes a dated JSON record.
 *
 * Dry run (default): no network. In-repo preconditions only.
 * --live: also calls the Farside API (FARSIDE_API_URL + FARSIDE_OPERATOR_TOKEN).
 *   Missing either is a clean skip (exit 0). Steps owned by iac-hub, base,
 *   Identity or Launch are never automated: they stay "manual" unless the
 *   operator lists them in --confirmed after doing them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REQUIRED_STEPS, lintRunbook } from "./lint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_OUT_DIR = join(ROOT, "docs/rehearsals");
const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const ACCOUNT = /^\d{12}$/;
const PAN = /\b\d{13,19}\b/;

export const MANUAL_STEPS = new Set(["register-product", "create-account", "deploy-base", "deploy-identity", "deploy-launch", "claim-org"]);

export function parseArgs(argv) {
  const args = { live: false, confirmed: [], outDir: null, write: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index] ?? "";
    if (arg === "--live") args.live = true;
    else if (arg === "--no-write") args.write = false;
    else if (arg === "--customer") args.customer = value();
    else if (arg === "--account") args.account = value();
    else if (arg === "--org") args.org = value();
    else if (arg === "--tenant") args.tenant = value();
    else if (arg === "--subscription") args.subscription = value();
    else if (arg === "--out-dir") args.outDir = value();
    else if (arg === "--confirmed") args.confirmed = value().split(",").filter(Boolean);
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

export function runbookTitles(markdown) {
  const titles = {};
  for (const id of REQUIRED_STEPS) {
    const match = markdown.match(new RegExp(`^### (\\d+)\\. (.+) \\{#${id}\\}$`, "m"));
    titles[id] = match ? `${match[1]}. ${match[2]}` : id;
  }
  return titles;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function registeredAccount(registry, customer) {
  if (registry.productDev?.customer === customer) return registry.productDev.accountId;
  return Object.hasOwn(registry.customers ?? {}, customer) ? registry.customers[customer] : undefined;
}

export function contractBody(now) {
  return { plan: "farside-standard", startDate: now, currency: "USD", amountDue: "0.00" };
}

/** In-repo precondition checks. Each returns a list of problems (empty = ready). */
export function preconditions(input, root = ROOT) {
  const { customer, account, org, tenant, subscription, appTenant, now } = input;
  const registry = readJson(join(root, "infra/accounts.json"));
  const customers = existsSync(join(root, "infra/customers.json")) ? readJson(join(root, "infra/customers.json")) : {};
  const entry = existsSync(join(root, "infra/iac-hub/products-entry.ts"))
    ? readFileSync(join(root, "infra/iac-hub/products-entry.ts"), "utf8")
    : "";
  const workflows = (name) => existsSync(join(root, ".github/workflows", name));
  return {
    "record-contract": [
      ...(org ? [] : ["--org is required"]),
      ...(PAN.test(JSON.stringify(contractBody(now))) ? ["contract body carries card-like digits"] : []),
    ],
    "register-product": [
      ...(entry.includes('targetRepo: "moonaan-farside"') ? [] : ["infra/iac-hub/products-entry.ts missing or not targeting moonaan-farside"]),
      ...["backend-publish.yml", "infra-pulumi_up.yaml", "infra-pulumi_destroy.yaml", "ui-deploy.yml"]
        .filter((name) => !workflows(name))
        .map((name) => `stage workflow ${name} missing`),
    ],
    "create-account": [
      ...(customer && SLUG.test(customer) ? [] : [`customer slug '${customer ?? ""}' is not a tenant slug`]),
      ...(account && ACCOUNT.test(account) ? [] : ["account id must be 12 digits"]),
      ...(customer && account && registeredAccount(registry, customer) !== account
        ? [`account ${account} is not registered to ${customer} in infra/accounts.json`]
        : []),
    ],
    "deploy-base": [],
    "deploy-identity": [],
    "deploy-launch": [],
    "deploy-farside": [
      ...(workflows("deploy-customer.yml") ? [] : ["deploy-customer.yml missing"]),
      ...(customer && Object.hasOwn(customers, customer) ? [] : [`customer ${customer ?? ""} has no entry in infra/customers.json`]),
    ],
    "claim-org": [],
    "connect-azure": [
      ...(tenant ? [] : ["--tenant is required"]),
      ...(subscription ? [] : ["--subscription is required"]),
      ...(tenant && appTenant && tenant === appTenant ? ["tenant is the app-registration tenant; use another tenant"] : []),
    ],
    "first-scan": [...(subscription ? [] : ["--subscription is required"])],
  };
}

async function call(deps, method, path, body, headers) {
  const response = await deps.fetchImpl(`${deps.apiUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** Live checks for Farside-owned steps. Returns { ok, detail }. */
export const LIVE = {
  async "record-contract"(input, deps) {
    const result = await call(deps, "PUT", `/v1/orgs/${input.org}/contract`, contractBody(input.now), {
      "x-farside-operator": deps.operatorToken,
    });
    const ok = result.status === 200 && result.json?.canScan === true && Array.isArray(result.json?.invoices);
    return { ok, detail: `PUT contract ${result.status}${ok ? "" : ` ${JSON.stringify(result.json)?.slice(0, 200)}`}` };
  },
  async "deploy-farside"(_input, deps) {
    if (!deps.consoleUrl) {
      return { ok: null, detail: "FARSIDE_CONSOLE_URL unset; console load not checked" };
    }
    const response = await deps.fetchImpl(deps.consoleUrl, { method: "GET" });
    return { ok: response.status === 200, detail: `GET console ${response.status}` };
  },
  async "connect-azure"(input, deps) {
    const result = await call(
      deps,
      "PUT",
      `/v1/orgs/${input.org}/connections`,
      { tenantId: input.tenant, subscriptionId: input.subscription },
      { "x-farside-org": input.org, "x-farside-actor": "rehearsal" },
    );
    return { ok: result.status === 201, detail: `PUT connections ${result.status}` };
  },
  async "first-scan"(input, deps) {
    for (let attempt = 0; attempt < (deps.maxPolls ?? 60); attempt += 1) {
      const result = await call(deps, "GET", `/v1/orgs/${input.org}/scans`, null, {
        "x-farside-org": input.org,
        "x-farside-actor": "rehearsal",
      });
      const scans = Array.isArray(result.json?.scans) ? result.json.scans : Array.isArray(result.json) ? result.json : [];
      const latest = scans.filter((scan) => scan.subscriptionId === input.subscription).at(-1);
      if (latest?.status === "succeeded") return { ok: true, detail: `scan ${latest.id} succeeded` };
      if (latest?.status === "failed") return { ok: false, detail: `scan ${latest.id} failed: ${latest.error ?? "unknown"}` };
      await deps.sleep(deps.pollMs ?? 5000);
    }
    return { ok: false, detail: "no succeeded scan before the poll limit" };
  },
};

export async function rehearse({
  argv = [],
  env = process.env,
  root = ROOT,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = new Date().toISOString(),
} = {}) {
  const args = parseArgs(argv);
  const registry = readJson(join(root, "infra/accounts.json"));
  const customer = args.customer ?? Object.keys(registry.customers ?? {})[0];
  const input = {
    customer,
    account: args.account ?? (customer ? registeredAccount(registry, customer) : undefined),
    org: args.org ?? customer,
    tenant: args.tenant ?? "rehearsal-tenant",
    subscription: args.subscription ?? "rehearsal-subscription",
    appTenant: env.AZURE_APP_REGISTRATION_TENANT_ID,
    now,
  };
  const markdown = readFileSync(join(root, "docs/operator-runbook.md"), "utf8");
  const runbookErrors = lintRunbook(markdown);
  const titles = runbookTitles(markdown);
  const problems = preconditions(input, root);
  let mode = args.live ? "live" : "dry-run";
  let note = "Dry run: preconditions only. No live call was made; this is not a rehearsal on a test tenant.";
  if (args.live && (!env.FARSIDE_API_URL || !env.FARSIDE_OPERATOR_TOKEN)) {
    mode = "live-skipped";
    note = "Live mode skipped: FARSIDE_API_URL and FARSIDE_OPERATOR_TOKEN are required. Preconditions only; no live call was made.";
  } else if (args.live) {
    note = "Live mode: Farside API steps were called. Manual steps are recorded only as the operator confirmed them.";
  }
  const deps = {
    fetchImpl,
    sleep,
    apiUrl: env.FARSIDE_API_URL,
    operatorToken: env.FARSIDE_OPERATOR_TOKEN,
    consoleUrl: env.FARSIDE_CONSOLE_URL,
  };
  const steps = [];
  let halted = false;
  for (const id of REQUIRED_STEPS) {
    const step = { id, title: titles[id], problems: problems[id] };
    if (halted) {
      steps.push({ ...step, status: "not-reached" });
      continue;
    }
    if (step.problems.length > 0) {
      steps.push({ ...step, status: "blocked" });
      halted = mode === "live";
      continue;
    }
    if (MANUAL_STEPS.has(id)) {
      const confirmed = mode === "live" && args.confirmed.includes(id);
      steps.push({ ...step, status: confirmed ? "operator-confirmed" : "manual" });
      if (mode === "live" && !confirmed) halted = true;
      continue;
    }
    if (mode !== "live") {
      steps.push({ ...step, status: "ready" });
      continue;
    }
    try {
      const result = await LIVE[id](input, deps);
      steps.push({ ...step, status: result.ok === null ? "unchecked" : result.ok ? "passed" : "failed", detail: result.detail });
      if (result.ok === false) halted = true;
    } catch (error) {
      steps.push({ ...step, status: "failed", detail: String(error instanceof Error ? error.message : error) });
      halted = true;
    }
  }
  const failed = steps.some((step) => step.status === "failed" || step.status === "blocked") || runbookErrors.length > 0;
  const record = {
    kind: "farside-rehearsal/1",
    date: now.slice(0, 10),
    at: now,
    mode,
    note,
    customer: input.customer,
    accountId: input.account ?? null,
    orgId: input.org,
    runbookErrors,
    steps,
    summary: Object.fromEntries(
      [...new Set(steps.map((step) => step.status))].map((status) => [status, steps.filter((step) => step.status === status).length]),
    ),
    result: failed ? "fail" : mode === "live" && steps.every((step) => ["passed", "operator-confirmed"].includes(step.status)) ? "pass" : "incomplete",
  };
  let file = null;
  if (args.write) {
    const dir = args.outDir ?? join(root, "docs/rehearsals");
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${record.date}-${input.customer ?? "unknown"}-${mode}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  return { record, file, exitCode: failed ? 1 : 0 };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  try {
    const { record, file, exitCode } = await rehearse({ argv: process.argv.slice(2) });
    console.log(record.note);
    for (const step of record.steps) {
      const extra = step.problems.length > 0 ? ` (${step.problems.join("; ")})` : step.detail ? ` (${step.detail})` : "";
      console.log(`  ${step.status.padEnd(18)} ${step.title}${extra}`);
    }
    console.log(`result: ${record.result}${file ? `; record ${file}` : ""}`);
    process.exit(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
