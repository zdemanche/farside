import { pino } from "pino";
import { systemClock, type Clock } from "./clock.js";
import { guardHarvester, isDemoOrg } from "./demo.js";
import { audit, auditRetention, loggerFromEnv, pinoOptions, type LogSink } from "./observability.js";
import { ScanRunner, unconfiguredHarvester } from "./scans.js";
import { ScanScheduler, type ScheduleTick } from "./scheduler.js";
import { MemoryStore, runRetentionSweep } from "./store.js";

const SETTLE_MS = 240_000;
const POLL_MS = 250;

export type TickSummary = {
  orgs: Array<{ orgId: string; action: ScheduleTick["action"] }>;
  retired: number;
};

export type TickDeps = {
  store: MemoryStore;
  scheduler: Pick<ScanScheduler, "tick">;
  clock: Clock;
  log: LogSink;
  settleMs?: number;
  pollMs?: number;
};

type StartedScan = { orgId: string; jobId: string };

function isPending(store: MemoryStore, { orgId, jobId }: StartedScan): boolean {
  const status = store.getJob(orgId, jobId)?.status;
  return status === "queued" || status === "running";
}

async function settle(started: StartedScan[], deps: TickDeps) {
  const deadline = Date.now() + (deps.settleMs ?? SETTLE_MS);
  while (started.some((scan) => isPending(deps.store, scan)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? POLL_MS));
  }
  const abandoned = started.filter((scan) => isPending(deps.store, scan));
  for (const orgId of new Set(abandoned.map((scan) => scan.orgId))) {
    audit(deps.log, "schedule.settle_abandoned", {
      orgId,
      scanIds: abandoned.filter((scan) => scan.orgId === orgId).map((scan) => scan.jobId),
    });
  }
}

export async function runScheduledTick(deps: TickDeps): Promise<TickSummary> {
  const { store, scheduler, clock, log } = deps;
  const retired = runRetentionSweep(store, clock);
  auditRetention(log, retired);
  const summary: TickSummary = { orgs: [], retired: retired.length };
  const started: StartedScan[] = [];
  for (const orgId of store.orgIds().filter((id) => !isDemoOrg(id))) {
    try {
      const tick = scheduler.tick(orgId, clock());
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

const store = new MemoryStore(systemClock);
const log = pino(pinoOptions(loggerFromEnv()) || {});
const runner = new ScanRunner(store, guardHarvester(unconfiguredHarvester()), {}, systemClock, log);
const scheduler = new ScanScheduler(store, runner, systemClock, log);

export async function handler(): Promise<TickSummary> {
  return runScheduledTick({ store, scheduler, clock: systemClock, log });
}
