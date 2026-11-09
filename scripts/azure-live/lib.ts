import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Inventory } from "@farside/scan-contracts";
import { AZURE_CLIENT_ID_ENV, AZURE_LIVE_ENV, azureLiveWiring } from "../../backend/src/azure-live-harvest.js";
import { assertionFileFromEnv, fileAssertionSource, isGuid, isTenantId } from "../../backend/src/azure-federated.js";
import type { ArmOptions, FetchLike } from "../../backend/src/azure-live.js";
import type { ScanOutput, SubscriptionMap } from "../../backend/src/ground-truth-diff.js";
import { asMutable } from "../../backend/src/readonly.js";
import { ScanRunner, unconfiguredHarvester, type ScanJob } from "../../backend/src/scans.js";
import { assertNoSecrets } from "../../backend/src/secrets.js";
import { MemoryStore } from "../../backend/src/store.js";

/**
 * Shared plumbing for the live Azure runners. Every runner skips (exit 0, nothing written)
 * without credentials. Records go to docs/azure/live-runs/<liveRunAt>-<kind>.json and name
 * subscriptions by manifest alias, never by real tenant or subscription id.
 */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const LIVE_RUNS_DIR = "docs/azure/live-runs";
export const SKIP_MESSAGE = "skipped: no Azure credentials";
export const RUN_ORG = "live-run";

export const RUN_ENV = {
  tenant: "FARSIDE_AZURE_TENANT_ID",
  main: "FARSIDE_AZURE_SUBSCRIPTION_ID",
  empty: "FARSIDE_AZURE_EMPTY_SUBSCRIPTION_ID",
  home: "FARSIDE_AZURE_HOME_TENANT_ID",
  agreement: "FARSIDE_AZURE_AGREEMENT_TYPE",
} as const;

export type RunEnv = {
  clientId: string;
  assertionFile: string;
  tenantId: string;
  subscriptions: SubscriptionMap & { main: string };
  homeTenantId: string | null;
  agreementType: string | null;
};

export type RunIo = {
  env?: NodeJS.Dict<string>;
  root?: string;
  fetch?: FetchLike;
  now?: () => Date;
  stdout?: { write: (chunk: string) => void };
  stderr?: { write: (chunk: string) => void };
};

/** Null when anything needed for a live run is missing. Never throws: no credentials is a skip. */
export function runEnvFromEnv(env: NodeJS.Dict<string>): { runEnv: RunEnv | null; missing: string[] } {
  const value = (name: string) => (typeof env[name] === "string" && env[name] !== "" ? (env[name] as string) : null);
  const clientId = value(AZURE_CLIENT_ID_ENV);
  const assertionFile = assertionFileFromEnv(env);
  const tenantId = value(RUN_ENV.tenant);
  const main = value(RUN_ENV.main);
  const missing = [
    ...(env[AZURE_LIVE_ENV] === "1" ? [] : [`${AZURE_LIVE_ENV}=1`]),
    ...(clientId && isGuid(clientId) ? [] : [AZURE_CLIENT_ID_ENV]),
    ...(assertionFile ? [] : ["an assertion file (FARSIDE_AZURE_ASSERTION_FILE)"]),
    ...(tenantId && isTenantId(tenantId) ? [] : [RUN_ENV.tenant]),
    ...(main ? [] : [RUN_ENV.main]),
  ];
  if (missing.length > 0 || !clientId || !assertionFile || !tenantId || !main) {
    return { runEnv: null, missing };
  }
  const empty = value(RUN_ENV.empty);
  return {
    runEnv: {
      clientId,
      assertionFile,
      tenantId,
      subscriptions: { main, ...(empty ? { "empty-no-budget": empty } : {}) },
      homeTenantId: value(RUN_ENV.home),
      agreementType: value(RUN_ENV.agreement),
    },
    missing: [],
  };
}

export function out(io: RunIo, line: string): void {
  (io.stdout ?? process.stdout).write(`${line}\n`);
}

export function err(io: RunIo, line: string): void {
  (io.stderr ?? process.stderr).write(`${line}\n`);
}

/** Resolves the run environment, or prints the skip line. Refuses a client secret outright. */
export function startRun(io: RunIo): RunEnv | null | "refused" {
  const env = io.env ?? process.env;
  if (typeof env.AZURE_CLIENT_SECRET === "string" && env.AZURE_CLIENT_SECRET.length > 0) {
    err(io, "refused: AZURE_CLIENT_SECRET is set; live runs use federated credentials only");
    return "refused";
  }
  const { runEnv, missing } = runEnvFromEnv(env);
  if (!runEnv) {
    out(io, `${SKIP_MESSAGE} (needs ${missing.join(", ")})`);
  }
  return runEnv;
}

export function nowOf(io: RunIo): Date {
  return (io.now ?? (() => new Date()))();
}

export function liveRunDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Writes one dated record; refuses anything that looks like a secret or token. */
export function writeRecord(io: RunIo, record: { kind: string; liveRunAt: string } & Record<string, unknown>): string {
  assertNoSecrets(record);
  const relative = join(LIVE_RUNS_DIR, `${record.liveRunAt}-${record.kind}.json`);
  const path = join(io.root ?? ROOT, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return relative;
}

export function recordExists(io: RunIo, liveRunAt: string, kind: string): boolean {
  return existsSync(join(io.root ?? ROOT, LIVE_RUNS_DIR, `${liveRunAt}-${kind}.json`));
}

/** Replaces real ids with manifest aliases before anything is printed or written. */
export function aliasIds(runEnv: RunEnv, text: string): string {
  let result = text;
  for (const [alias, id] of Object.entries(runEnv.subscriptions)) {
    if (id) {
      result = result.split(id).join(alias);
    }
  }
  return result.split(runEnv.tenantId).join("customer-tenant");
}

export function liveWiring(runEnv: RunEnv, io: RunIo, store = new MemoryStore(() => nowOf(io).toISOString())) {
  const clock = () => nowOf(io).toISOString();
  const wiring = azureLiveWiring(
    { clientId: runEnv.clientId, assertion: fileAssertionSource(runEnv.assertionFile) },
    { store, fallback: unconfiguredHarvester(), clock, ...(io.fetch ? { fetch: io.fetch } : {}) },
  );
  const arm: ArmOptions = {
    token: wiring.tokenFor(runEnv.tenantId),
    now: () => nowOf(io),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  };
  return { store, wiring, arm, clock };
}

export type LiveScan = { output: ScanOutput; jobs: Array<{ alias: string; job: ScanJob }> };

/** The production scan path (actor: system) against each configured subscription. */
export async function liveScan(runEnv: RunEnv, io: RunIo): Promise<LiveScan> {
  const { store, wiring, clock } = liveWiring(runEnv, io);
  const runner = new ScanRunner(store, wiring.harvester, wiring.harvestClients, clock);
  const jobs: LiveScan["jobs"] = [];
  for (const [alias, subscriptionId] of Object.entries(runEnv.subscriptions)) {
    if (!subscriptionId) {
      continue;
    }
    await store.putConnection(RUN_ORG, { tenantId: runEnv.tenantId, subscriptionId, cloud: "azure" });
    const started = await runner.start({ orgId: RUN_ORG, subscriptionId, actor: "system" });
    jobs.push({ alias, job: await started.done });
  }
  const org = await store.read(RUN_ORG, "findings", "coverage", "inventories", "costs");
  const inventory = asMutable<Inventory | undefined>(org.inventories.azure) ?? {
    cloud: "azure",
    observedAt: clock(),
    resources: [],
  };
  return {
    output: { findings: org.findings, coverage: org.coverage, inventory } as ScanOutput,
    jobs,
  };
}

/** Runs `main` when the file is executed directly (`tsx scripts/azure-live/<runner>.ts`). */
export async function runIfMain(url: string, main: (argv: string[]) => Promise<number>): Promise<void> {
  const entry = process.argv[1];
  if (entry && pathToFileURL(entry).href === url) {
    process.exitCode = await main(process.argv.slice(2));
  }
}
