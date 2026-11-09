import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Finding, Inventory } from "@farside/scan-contracts";
import type { CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import { GCP_COMMITTED_USE } from "./gcp-commitments.js";
import { GCP_SPEND_BY_SERVICE, harvestGcpCost, type BigQueryExportClient } from "./gcp-cost.js";
import {
  factsFromGcpManifest,
  inventoryFromGcpManifest,
  type GcpGroundTruthManifest,
} from "./gcp-inventory.js";
import {
  GcpLiveConfigError,
  describeGcpLiveConfig,
  gcpLiveClients,
  gcpLiveConfigFromEnv,
  liveGcpHarvester,
  type GcpLiveDeps,
} from "./gcp-live-harvester.js";
import { REC_TYPE } from "./gcp-recommender.js";
import { LIVE_RUNS_DIR, writeRunRecord } from "./gcp-role-verify.js";
import "./providers/index.js";
import { gcpProvider } from "./providers/gcp.js";
import type { Harvester } from "./providers/types.js";
import { assertNoSecrets } from "./secrets.js";
import { DEFAULT_SETTINGS, type OrgSettings } from "./settings.js";
import docGcpGroundTruth from "../../docs/gcp/ground-truth.json" with { type: "json" };
import docGcpLiveSeed from "../../docs/gcp/live-seed.json" with { type: "json" };

/**
 * Runs every GCP check against a live project and diffs findings against the seeded manifest.
 * Expected results are what the same checks return on docs/gcp/ground-truth.json, minus the
 * cases docs/gcp/live-seed.json marks unseedable. Nothing here has run live yet.
 */
export const CHECK_RUN_KIND = "gcp-live-check-run";
export const INVENTORY_ALL = "gcp-inventory-all-assets";
export const INVENTORY_NO_OWNER = "gcp-inventory-no-owner-label";

type Result = Finding["result"];
export type CaseMap = Map<string, Map<string, Result>>;

export type LiveSeed = {
  unseedable: Record<string, string>;
  ignoreNamePrefixes: string[];
};

export type CheckRun = {
  checkId: string;
  result: "pass" | "fail" | "not-run";
  reason?: string;
  expected: number;
  matched: number;
  missing: string[];
  mismatched: Array<{ key: string; expected: Result; live: Result }>;
  unexpected: string[];
  summary?: Record<string, string | number | boolean | null>;
};

export type CheckRunRecord = {
  kind: typeof CHECK_RUN_KIND;
  cloud: "gcp";
  liveRunAt: string;
  startedAt: string;
  finishedAt: string;
  projectId: string;
  manifest: string;
  settings: { ownerTagKey: string; snapshotRetentionDays: number; certExpiryFlagDays: number };
  connection: ReturnType<typeof describeGcpLiveConfig> | null;
  error: string | null;
  checks: CheckRun[];
};

const SEED = docGcpLiveSeed as LiveSeed;
const MANIFEST = docGcpGroundTruth as GcpGroundTruthManifest;
const NOT_DIFFED: Record<string, string> = {
  [GCP_COMMITTED_USE]: "No live committed-use reader is built and the seed buys no commitment.",
};
const BLOCKING_CAUSES = new Set(["missing_role", "throttling", "failed_call"]);

function lastSegment(uri: string): string {
  return uri.split("/").filter(Boolean).pop() ?? uri;
}

/** Recommendations key on the resource they name, so live ids still line up with the manifest. */
export function findingKey(finding: Finding): string | null {
  const fields = finding.evidence.fields;
  const uri = fields.resourceUri;
  if (typeof uri === "string" && uri.length > 0) {
    return lastSegment(uri);
  }
  const name = fields.commitmentName;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function diffedChecks() {
  return gcpProvider.checks.filter((check) => !(check.checkId in NOT_DIFFED));
}

export function casesFrom(
  inventory: Inventory,
  facts: ResourceFacts[],
  settings: OrgSettings,
): CaseMap {
  const cases: CaseMap = new Map();
  const resources = inventory.resources.filter((resource) => resource.resourceType !== REC_TYPE);
  cases.set(
    INVENTORY_ALL,
    new Map(resources.map((resource) => [lastSegment(resource.resourceUri), "pass" as Result])),
  );
  cases.set(
    INVENTORY_NO_OWNER,
    new Map(
      resources.map((resource) => [
        lastSegment(resource.resourceUri),
        (resource.ownerTag ? "pass" : "fail") as Result,
      ]),
    ),
  );
  for (const check of diffedChecks()) {
    const byKey = new Map<string, Result>();
    for (const finding of check(inventory, facts, settings)) {
      const key = findingKey(finding);
      if (key) {
        byKey.set(key, finding.result);
      }
    }
    cases.set(check.checkId, byKey);
  }
  return cases;
}

export function expectedFromManifest(
  manifest: GcpGroundTruthManifest = MANIFEST,
  settings: OrgSettings = DEFAULT_SETTINGS,
  seed: LiveSeed = SEED,
): CaseMap {
  const cases = casesFrom(
    inventoryFromGcpManifest(manifest),
    factsFromGcpManifest(manifest),
    settings,
  );
  for (const byKey of cases.values()) {
    for (const key of Object.keys(seed.unseedable)) {
      byKey.delete(key);
    }
  }
  return cases;
}

export function diffCases(
  checkId: string,
  expected: ReadonlyMap<string, Result>,
  live: ReadonlyMap<string, Result>,
  ignorePrefixes: readonly string[] = SEED.ignoreNamePrefixes,
): CheckRun {
  const missing: string[] = [];
  const mismatched: CheckRun["mismatched"] = [];
  let matched = 0;
  for (const [key, want] of expected) {
    const got = live.get(key);
    if (got === undefined) {
      missing.push(key);
    } else if (got !== want) {
      mismatched.push({ key, expected: want, live: got });
    } else {
      matched += 1;
    }
  }
  // Extra live passes are fine (boot disks, managed nodes); an extra failure is a false positive.
  const unexpected = [...live]
    .filter(([key, result]) => !expected.has(key) && result === "fail")
    .map(([key]) => key)
    .filter((key) => !ignorePrefixes.some((prefix) => key.startsWith(prefix)));
  const ok = missing.length === 0 && mismatched.length === 0 && unexpected.length === 0;
  return {
    checkId,
    result: ok ? "pass" : "fail",
    expected: expected.size,
    matched,
    missing,
    mismatched,
    unexpected,
  };
}

function blockedBy(coverage: readonly CoverageEntry[], checkId: string): string | null {
  const entry = coverage.find(
    (item) => item.checkId === checkId && item.causeId && BLOCKING_CAUSES.has(item.causeId),
  );
  return entry ? `coverage ${entry.state} (${entry.causeId})` : null;
}

function notRun(checkId: string, reason: string, summary?: CheckRun["summary"]): CheckRun {
  return {
    checkId,
    result: "not-run",
    reason,
    expected: 0,
    matched: 0,
    missing: [],
    mismatched: [],
    unexpected: [],
    ...(summary ? { summary } : {}),
  };
}

async function spendCheck(
  client: BigQueryExportClient | undefined,
  projectId: string,
): Promise<CheckRun> {
  if (!client) {
    return notRun(GCP_SPEND_BY_SERVICE, "FARSIDE_GCP_BILLING_EXPORT_TABLE is not set.");
  }
  const harvest = await harvestGcpCost({ client, projectId });
  if (!harvest.ok) {
    return {
      ...notRun(GCP_SPEND_BY_SERVICE, `Billing export harvest: ${harvest.reason}`),
      result: "fail",
    };
  }
  return notRun(
    GCP_SPEND_BY_SERVICE,
    "Harvest read. Needs a manual comparison against the GCP console.",
    {
      serviceCount: harvest.snapshot.services.length,
      currency: harvest.snapshot.currency || null,
    },
  );
}

export async function runGcpLiveChecks(input: {
  projectId: string;
  harvester: Harvester;
  settings?: OrgSettings;
  costClient?: BigQueryExportClient;
  connection?: CheckRunRecord["connection"];
  now?: () => Date;
  expected?: CaseMap;
}): Promise<CheckRunRecord> {
  const now = input.now ?? (() => new Date());
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const started = now();
  const expected = input.expected ?? expectedFromManifest(MANIFEST, settings);
  const base = {
    kind: CHECK_RUN_KIND as typeof CHECK_RUN_KIND,
    cloud: "gcp" as const,
    liveRunAt: started.toISOString().slice(0, 10),
    startedAt: started.toISOString(),
    projectId: input.projectId,
    manifest: "docs/gcp/ground-truth.json",
    settings: {
      ownerTagKey: settings.ownerTagKey,
      snapshotRetentionDays: settings.snapshotRetentionDays,
      certExpiryFlagDays: settings.certExpiryFlagDays,
    },
    connection: input.connection ?? null,
  };
  const ids = gcpProvider.launchCheckIds;
  let checks: CheckRun[];
  let error: string | null = null;
  try {
    const harvest = await input.harvester.harvest({
      orgId: "gcp-live-run",
      subscriptionId: input.projectId,
      settings,
    });
    const live = casesFrom(harvest.inventory, harvest.facts, settings);
    checks = [];
    for (const checkId of ids) {
      if (checkId === GCP_SPEND_BY_SERVICE) {
        checks.push(await spendCheck(input.costClient, input.projectId));
        continue;
      }
      const skip = NOT_DIFFED[checkId];
      if (skip) {
        checks.push(notRun(checkId, skip));
        continue;
      }
      const run = diffCases(
        checkId,
        expected.get(checkId) ?? new Map(),
        live.get(checkId) ?? new Map(),
      );
      const blocked = blockedBy(harvest.coverage, checkId);
      checks.push(blocked ? { ...run, result: "fail", reason: blocked } : run);
    }
  } catch (caught) {
    // Only the error name: messages from HTTP layers must not reach a committed record.
    error = caught instanceof Error ? caught.name : "Error";
    checks = ids.map((checkId) => notRun(checkId, `Harvest failed: ${error}`));
  }
  const record: CheckRunRecord = { ...base, finishedAt: now().toISOString(), error, checks };
  assertNoSecrets(record);
  return record;
}

type SpecCheck = { id: string; status: string; support: string; liveRunAt: string | null };
type Spec = { checks: SpecCheck[] };

/** A passing live diff marks the spec entry verified with the run date (latest pass wins). */
export function applyRecordToSpec<T extends Spec>(
  spec: T,
  record: Pick<CheckRunRecord, "liveRunAt" | "checks">,
): T {
  const passed = new Set(
    record.checks.filter((check) => check.result === "pass").map((check) => check.checkId),
  );
  return {
    ...spec,
    checks: spec.checks.map((check) => {
      if (!passed.has(check.id)) {
        return check;
      }
      const liveRunAt =
        check.liveRunAt && check.liveRunAt > record.liveRunAt ? check.liveRunAt : record.liveRunAt;
      return { ...check, status: "verified", support: "supported", liveRunAt };
    }),
  };
}

/**
 * Same change as applyRecordToSpec, made in place on the JSON text so the hand-formatted
 * spec keeps its layout. The parsed result is checked against applyRecordToSpec.
 */
export function applyRecordToSpecText(
  text: string,
  record: Pick<CheckRunRecord, "liveRunAt" | "checks">,
): string {
  const want = applyRecordToSpec(JSON.parse(text) as Spec, record);
  let next = text;
  for (const check of want.checks) {
    if (check.status !== "verified") {
      continue;
    }
    const start = next.indexOf(`"id": ${JSON.stringify(check.id)}`);
    const end = next.indexOf('"id": ', start + 1);
    const stop = end === -1 ? next.length : end;
    const block = next
      .slice(start, stop)
      .replace(/"status": "[^"]*"/, '"status": "verified"')
      .replace(/"support": "[^"]*"/, '"support": "supported"')
      .replace(/"liveRunAt": (null|"[^"]*")/, `"liveRunAt": ${JSON.stringify(check.liveRunAt)}`);
    next = `${next.slice(0, start)}${block}${next.slice(stop)}`;
  }
  if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(want)) {
    throw new Error("launch-checks.json could not be updated in place");
  }
  return next;
}

const SPEC_PATH = fileURLToPath(new URL("../../docs/gcp/launch-checks.json", import.meta.url));
const MATRIX_GENERATOR = fileURLToPath(
  new URL("../../scripts/support-matrix/generate.mjs", import.meta.url),
);

export type RunMainIo = {
  env?: NodeJS.Dict<string>;
  deps?: GcpLiveDeps;
  out?: (line: string) => void;
  dir?: string;
  specPath?: string;
  regenerate?: () => void;
};

export async function main(io: RunMainIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  let config;
  try {
    config = gcpLiveConfigFromEnv(io.env ?? process.env);
  } catch (caught) {
    if (caught instanceof GcpLiveConfigError) {
      out(caught.message);
      return 1;
    }
    throw caught;
  }
  if (!config) {
    out("skipped: no GCP credentials");
    return 0;
  }
  const clients = gcpLiveClients(config, io.deps);
  const record = await runGcpLiveChecks({
    projectId: config.projectId,
    harvester: liveGcpHarvester(clients),
    ...(clients.bigQuery ? { costClient: clients.bigQuery } : {}),
    connection: describeGcpLiveConfig(config),
    ...(io.deps?.now ? { now: io.deps.now } : {}),
  });
  const path = writeRunRecord(
    io.dir ?? LIVE_RUNS_DIR,
    `${record.liveRunAt}-${record.projectId}-checks.json`,
    record,
  );
  out(`live run record: ${path}`);
  for (const check of record.checks) {
    out(`${check.checkId}: ${check.result}${check.reason ? ` (${check.reason})` : ""}`);
  }
  const specPath = io.specPath ?? SPEC_PATH;
  writeFileSync(specPath, applyRecordToSpecText(readFileSync(specPath, "utf8"), record));
  (
    io.regenerate ??
    (() => execFileSync(process.execPath, [MATRIX_GENERATOR, "--write"], { stdio: "inherit" }))
  )();
  return record.error || record.checks.some((check) => check.result === "fail") ? 1 : 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await main();
}
