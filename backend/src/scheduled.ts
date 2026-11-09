import { pino } from "pino";
import { systemClock, type Clock } from "./clock.js";
import { azureLiveFromEnv } from "./azure-live-harvest.js";
import type { FetchLike } from "./azure-live.js";
import { guardClientSource, guardHarvester, isDemoOrg } from "./demo.js";
import { audit, auditRetention, loggerFromEnv, pinoOptions, type LogSink } from "./observability.js";
import { ScanRunner, unconfiguredHarvester } from "./scans.js";
import { ScanScheduler, type ScheduleTick } from "./scheduler.js";
import type { OrgRepository } from "./repository.js";
import { storeFromEnv } from "./store-from-env.js";
import { runRetentionSweep } from "./store.js";

const SETTLE_MS = 240_000;
const POLL_MS = 250;

export type TickSummary = {
  orgs: Array<{ orgId: string; action: ScheduleTick["action"] }>;
  retired: number;
};

export type TickDeps = {
  store: OrgRepository;
  scheduler: Pick<ScanScheduler, "tick">;
  clock: Clock;
  log: LogSink;
  settleMs?: number;
  pollMs?: number;
};

type StartedScan = { orgId: string; jobId: string };

async function isPending(store: OrgRepository, { orgId, jobId }: StartedScan): Promise<boolean> {
  const status = (await store.getJob(orgId, jobId))?.status;
  return status === "queued" || status === "running";
}

async function settle(started: StartedScan[], deps: TickDeps) {
  const deadline = Date.now() + (deps.settleMs ?? SETTLE_MS);
  const pending = async () => {
    const flags = await Promise.all(started.map((scan) => isPending(deps.store, scan)));
    return started.filter((_, index) => flags[index]);
  };
  while ((await pending()).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? POLL_MS));
  }
  const abandoned = await pending();
  for (const orgId of new Set(abandoned.map((scan) => scan.orgId))) {
    audit(deps.log, "schedule.settle_abandoned", {
      orgId,
      scanIds: abandoned.filter((scan) => scan.orgId === orgId).map((scan) => scan.jobId),
    });
  }
}

export async function runScheduledTick(deps: TickDeps): Promise<TickSummary> {
  const { store, scheduler, clock, log } = deps;
  let retired: Awaited<ReturnType<typeof runRetentionSweep>> = [];
  try {
    retired = await runRetentionSweep(store, clock);
    auditRetention(log, retired);
  } catch (error) {
    log.error({ err: error }, "retention sweep failed");
  }
  try {
    await store.repurgeDeleted(clock());
  } catch (error) {
    log.error({ err: error }, "deleted-org re-purge failed");
  }
  const summary: TickSummary = { orgs: [], retired: retired.length };
  const started: StartedScan[] = [];
  for (const orgId of (await store.orgIds()).filter((id) => !isDemoOrg(id))) {
    try {
      const tick = await scheduler.tick(orgId, clock());
      audit(log, "schedule.tick", {
        orgId,
        action: tick.action,
        reason: tick.record?.reason ?? null,
        subscriptionId: tick.record?.subscriptionId ?? null,
        scanId: tick.scan?.id ?? null,
        attention: tick.attention,
      });
      summary.orgs.push({ orgId, action: tick.action });
      for (const { scan, started: isStarted } of tick.scans) {
        if (isStarted) {
          started.push({ orgId, jobId: scan.id });
        }
      }
    } catch (error) {
      log.error({ err: error, orgId }, "schedule tick failed");
    }
  }
  await settle(started, deps);
  return summary;
}

const log = pino(pinoOptions(loggerFromEnv()) || {});

/** The unattended runner (actor: system). Live Azure only when switched on in the environment. */
export function scheduledRunner(
  store: OrgRepository,
  options: { env?: NodeJS.Dict<string>; clock?: Clock; log?: LogSink; fetch?: FetchLike } = {},
): ScanRunner {
  const clock = options.clock ?? systemClock;
  const sink = options.log ?? log;
  const live = azureLiveFromEnv(options.env ?? process.env, {
    store,
    fallback: unconfiguredHarvester(),
    clock,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return live
    ? new ScanRunner(store, guardHarvester(live.harvester), guardClientSource(live.harvestClients), clock, sink)
    : new ScanRunner(store, guardHarvester(unconfiguredHarvester()), {}, clock, sink);
}

async function createDeps(): Promise<TickDeps> {
  const store = await storeFromEnv(process.env, systemClock, log);
  const runner = scheduledRunner(store);
  return { store, scheduler: new ScanScheduler(store, runner, systemClock, log), clock: systemClock, log };
}

let deps: Promise<TickDeps> | undefined;

export async function handler(): Promise<TickSummary> {
  deps ??= createDeps().catch((error: unknown) => {
    deps = undefined;
    throw error;
  });
  return runScheduledTick(await deps);
}
