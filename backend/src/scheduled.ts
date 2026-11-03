import Fastify from "fastify";
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

async function settle(store: MemoryStore, started: Array<{ orgId: string; jobId: string }>, deps: TickDeps) {
  const deadline = Date.now() + (deps.settleMs ?? SETTLE_MS);
  const pending = () =>
    started.some(({ orgId, jobId }) => {
      const status = store.getJob(orgId, jobId)?.status;
      return status === "queued" || status === "running";
    });
  while (pending() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? POLL_MS));
  }
}

export async function runScheduledTick(deps: TickDeps): Promise<TickSummary> {
  const { store, scheduler, clock, log } = deps;
  const retired = runRetentionSweep(store, clock);
  auditRetention(log, retired);
  const summary: TickSummary = { orgs: [], retired: retired.length };
  const started: Array<{ orgId: string; jobId: string }> = [];
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
      if (tick.scan && tick.scanStarted) {
        started.push({ orgId, jobId: tick.scan.id });
      }
    } catch (error) {
      log.error({ err: error, orgId }, "schedule tick failed");
    }
  }
  await settle(store, started, deps);
  return summary;
}

const store = new MemoryStore(systemClock);
const log = Fastify({ logger: pinoOptions(loggerFromEnv()) }).log;
const runner = new ScanRunner(store, guardHarvester(unconfiguredHarvester()), {}, systemClock, log);
const scheduler = new ScanScheduler(store, runner, systemClock);

export async function handler(): Promise<TickSummary> {
  return runScheduledTick({ store, scheduler, clock: systemClock, log });
}
