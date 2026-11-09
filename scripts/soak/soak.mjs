#!/usr/bin/env node
/**
 * Scheduler soak (#167, #163).
 *
 * Simulated (default): drives the production tick path (runScheduledTick ->
 * ScanScheduler -> ScanRunner) on a MemoryStore with a controlled clock over N
 * schedule cycles, ticking every 15 minutes like the EventBridge schedule.
 * Optional injected harvest failures and dropped ticks exercise the detectors.
 *
 * Live (--live): reads schedule records and scans for one org from a deployed
 * API (FARSIDE_API_URL, FARSIDE_ORG) over [--since, --until] and runs the same
 * analysis. Missing env is a clean skip (exit 0). It never claims a soak ran.
 *
 *   node --import tsx scripts/soak/soak.mjs [--cycles 7] [--interval-hours 24]
 *     [--tick-minutes 15] [--failure-rate 0] [--drop-ticks 0] [--seed 1] [--out file]
 *   node --import tsx scripts/soak/soak.mjs --live --since <iso> [--until <iso>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { factsFromManifest } from "../../backend/src/facts.ts";
import { inventoryFromManifest } from "../../backend/src/inventory.ts";
import { fixtureHarvester } from "../../backend/src/providers/fixture-harvester.ts";
import { runScheduledTick } from "../../backend/src/scheduled.ts";
import { ScanRunner } from "../../backend/src/scans.ts";
import { ScanScheduler } from "../../backend/src/scheduler.ts";
import { MemoryStore } from "../../backend/src/store.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HOUR = 3_600_000;
const MINUTE = 60_000;

export function parseArgs(argv) {
  const args = { cycles: 7, intervalHours: 24, tickMinutes: 15, failureRate: 0, dropTicks: 0, seed: 1, live: false, out: null };
  const numbers = { "--cycles": "cycles", "--interval-hours": "intervalHours", "--tick-minutes": "tickMinutes", "--failure-rate": "failureRate", "--drop-ticks": "dropTicks", "--seed": "seed" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") args.live = true;
    else if (arg in numbers) {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${arg} needs a non-negative number`);
      args[numbers[arg]] = value;
    } else if (arg === "--since") args.since = argv[++index];
    else if (arg === "--until") args.until = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (args.intervalHours <= 0 || args.tickMinutes <= 0) throw new Error("interval and tick must be positive");
  return args;
}

/** Deterministic PRNG so a failing soak can be replayed with the same --seed. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure analysis over system scans and schedule records for one org.
 * Gap-based, so 15-minute tick drift does not count as a miss.
 */
export function analyse({ scans, records, since, until, intervalHours, toleranceMinutes = 30 }) {
  const interval = intervalHours * HOUR;
  const tolerance = toleranceMinutes * MINUTE;
  const from = Date.parse(since);
  const to = Date.parse(until);
  const actionOf = new Map(records.filter((record) => record.scanId).map((record) => [record.scanId, record.action]));
  const inWindow = scans
    .filter((scan) => scan.actor === "system")
    .filter((scan) => Date.parse(scan.createdAt) >= from - tolerance && Date.parse(scan.createdAt) <= to)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const subscriptions = [...new Set(inWindow.map((scan) => scan.subscriptionId))];
  const issues = [];
  const counts = { expected: 0, scheduled: 0, retries: 0, succeeded: 0, missed: 0, failed: 0, duplicates: 0, overlaps: 0, late: 0, pending: 0 };
  counts.expected = Math.max(0, Math.floor((to - from) / interval) + 1) * Math.max(1, subscriptions.length);
  counts.late = records.filter((record) => record.action === "missed" && Date.parse(record.at) >= from && Date.parse(record.at) <= to).length;
  if (subscriptions.length === 0) {
    counts.missed = counts.expected;
    if (counts.expected > 0) issues.push(`no system scan between ${since} and ${until}`);
  }
  for (const subscriptionId of subscriptions) {
    const own = inWindow.filter((scan) => scan.subscriptionId === subscriptionId);
    const primary = own.filter((scan) => actionOf.get(scan.id) !== "retried");
    counts.scheduled += primary.length;
    counts.retries += own.length - primary.length;
    counts.succeeded += own.filter((scan) => scan.status === "succeeded").length;
    let previous = from - interval;
    for (const scan of primary) {
      const at = Date.parse(scan.createdAt);
      const gap = at - previous;
      if (gap > interval + tolerance) {
        const lost = Math.max(1, Math.round(gap / interval) - 1);
        counts.missed += lost;
        issues.push(`${subscriptionId}: ${lost} run(s) missed before ${scan.createdAt}`);
      } else if (gap < interval - tolerance) {
        counts.duplicates += 1;
        issues.push(`${subscriptionId}: duplicate scheduled scan ${scan.id} ${Math.round(gap / MINUTE)} min after the previous run`);
        continue;
      }
      previous = at;
    }
    if (to - previous > interval + tolerance) {
      const lost = Math.floor((to - previous - tolerance) / interval);
      counts.missed += lost;
      issues.push(`${subscriptionId}: ${lost} run(s) missed after ${new Date(previous).toISOString()}`);
    }
    primary.forEach((scan, index) => {
      const next = primary[index + 1];
      const chain = own.filter(
        (item) => Date.parse(item.createdAt) >= Date.parse(scan.createdAt) && (!next || Date.parse(item.createdAt) < Date.parse(next.createdAt)),
      );
      const last = chain.at(-1);
      if (last.status === "failed") {
        counts.failed += 1;
        issues.push(`${subscriptionId}: run ${scan.id} failed after ${chain.length - 1} retr${chain.length === 2 ? "y" : "ies"} (${last.error ?? "no error"})`);
      } else if (last.status === "queued" || last.status === "running") {
        counts.pending += 1;
      }
    });
    for (let index = 1; index < own.length; index += 1) {
      const before = own[index - 1];
      const scan = own[index];
      if (scan.startedAt && before.startedAt && (!before.finishedAt || Date.parse(scan.startedAt) < Date.parse(before.finishedAt))) {
        counts.overlaps += 1;
        issues.push(`${subscriptionId}: ${scan.id} started while ${before.id} was still running`);
      }
    }
  }
  const pass = counts.missed === 0 && counts.failed === 0 && counts.duplicates === 0 && counts.overlaps === 0;
  return { pass, counts, issues };
}

/** Simulated soak on the production tick path. */
export async function simulate(args, manifest = JSON.parse(readFileSync(join(ROOT, "docs/azure/ground-truth.json"), "utf8"))) {
  const orgId = "soak";
  let now = Date.parse("2026-01-05T00:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  const random = mulberry32(args.seed);
  const base = fixtureHarvester(inventoryFromManifest(manifest), factsFromManifest(manifest), clock);
  let injected = 0;
  const harvester = {
    async harvest(input) {
      if (args.failureRate > 0 && random() < args.failureRate) {
        injected += 1;
        throw new Error("injected soak failure");
      }
      return base.harvest(input);
    },
  };
  const tickErrors = [];
  const log = { info: () => undefined, error: (obj, msg) => tickErrors.push(msg ?? JSON.stringify(obj)) };
  const store = new MemoryStore(clock);
  const runner = new ScanRunner(store, harvester, {}, clock);
  const scheduler = new ScanScheduler(store, runner, clock);
  await store.putSettings(orgId, {
    ...(await store.read(orgId, "settings")).settings,
    scanIntervalHours: args.intervalHours,
    scanScheduleEnabled: true,
  });
  await store.putConnection(orgId, { tenantId: "soak-tenant", subscriptionId: "main" });
  const schedule = await scheduler.applySettings(orgId, clock());
  const since = schedule.nextRunAt;
  const end = Date.parse(since) + args.cycles * args.intervalHours * HOUR;
  let ticks = 0;
  let dropped = 0;
  for (now = Date.parse(since); now < end; now += args.tickMinutes * MINUTE) {
    if (args.dropTicks > 0 && random() < args.dropTicks) {
      dropped += 1;
      continue;
    }
    ticks += 1;
    await runScheduledTick({ store, scheduler, clock, log, settleMs: 5_000, pollMs: 1 });
  }
  const until = new Date(end - args.tickMinutes * MINUTE).toISOString();
  const { scans, schedule: finalSchedule } = await store.read(orgId, "scans", "schedule");
  const analysis = analyse({
    scans: structuredClone(scans),
    records: structuredClone(finalSchedule.records),
    since,
    until,
    intervalHours: args.intervalHours,
    toleranceMinutes: args.tickMinutes * 2,
  });
  if (tickErrors.length > 0) {
    analysis.pass = false;
    analysis.issues.push(...tickErrors.map((error) => `tick error: ${error}`));
  }
  return { since, until, ticks, dropped, injectedFailures: injected, tickErrors: tickErrors.length, ...analysis };
}

/** Live analysis of an org's history on a deployed API. */
export async function live(args, env, fetchImpl = fetch) {
  const base = env.FARSIDE_API_URL?.replace(/\/$/, "");
  const orgId = env.FARSIDE_ORG;
  if (!base || !orgId || !args.since) {
    return { skipped: true, reason: "Live soak skipped: FARSIDE_API_URL, FARSIDE_ORG and --since are required. Nothing was read." };
  }
  const headers = { "x-farside-org": orgId, "x-farside-actor": env.FARSIDE_ACTOR ?? "soak" };
  const get = async (path) => {
    const response = await fetchImpl(`${base}${path}`, { method: "GET", headers });
    if (response.status !== 200) throw new Error(`GET ${path} returned ${response.status}`);
    return response.json();
  };
  const schedule = await get(`/v1/orgs/${orgId}/schedule`);
  const scans = [];
  let before = null;
  for (let page = 0; page < 20; page += 1) {
    const body = await get(`/v1/orgs/${orgId}/scans?limit=200${before ? `&before=${before}` : ""}`);
    const batch = (body.scans ?? []).filter((scan) => !scans.some((seen) => seen.id === scan.id));
    scans.unshift(...batch);
    if (batch.length === 0 || Date.parse(batch[0].createdAt) < Date.parse(args.since)) break;
    before = batch[0].id;
  }
  const until = args.until ?? new Date().toISOString();
  const analysis = analyse({
    scans,
    records: schedule.records ?? [],
    since: args.since,
    until,
    intervalHours: schedule.intervalHours ?? args.intervalHours,
    toleranceMinutes: args.tickMinutes * 2,
  });
  return { skipped: false, orgId, since: args.since, until, ...analysis };
}

export async function runSoak({ argv = [], env = process.env, fetchImpl = fetch, now = new Date().toISOString(), outDir = join(ROOT, "docs/soak") } = {}) {
  const args = parseArgs(argv);
  const result = args.live ? await live(args, env, fetchImpl) : await simulate(args);
  const mode = args.live ? (result.skipped ? "live-skipped" : "live") : "simulated";
  const record = {
    kind: "farside-soak/1",
    date: now.slice(0, 10),
    at: now,
    mode,
    note:
      mode === "simulated"
        ? "Simulated soak on an in-memory store with a controlled clock. Not the unattended week on the test subscription (#167)."
        : mode === "live"
          ? "Analysis of schedule records and scans read from the deployed API for the window below."
          : result.reason,
    parameters: args,
    ...result,
    result: result.skipped ? "skipped" : result.pass ? "pass" : "fail",
  };
  let file = null;
  if (args.out !== "-") {
    file = args.out ?? join(outDir, `${record.date}-${mode}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  return { record, file, exitCode: record.result === "fail" ? 1 : 0 };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  try {
    const { record, file, exitCode } = await runSoak({ argv: process.argv.slice(2) });
    console.log(record.note);
    if (record.counts) {
      console.log(Object.entries(record.counts).map(([key, value]) => `${key}=${value}`).join(" "));
      for (const issue of record.issues) console.log(`  ${issue}`);
    }
    console.log(`result: ${record.result}${file ? `; record ${file}` : ""}`);
    process.exit(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
