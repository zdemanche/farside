import { systemClock, type Clock } from "./clock.js";
import { emitDecision, silentLog, type LogSink } from "./observability.js";
import type { Connection, MemoryStore } from "./store.js";
import type { ScanJob, ScanRunner } from "./scans.js";

export const DEFAULT_INTERVAL_HOURS = 24;
export const DEFAULT_RETRY_LIMIT = 3;
export const RETRY_DELAY_HOURS = 1;
export const DEFAULT_SCAN_TIMEOUT_MS = 600_000;
export const MAX_SCHEDULE_RECORDS = 500;

export type ScheduleAction = "started" | "skipped_overlap" | "skipped_broken" | "retried" | "missed";

export type ScheduleRecord = {
  id: string;
  orgId: string;
  subscriptionId: string | null;
  at: string;
  action: ScheduleAction;
  reason: string | null;
  scanId: string | null;
};

export type ScheduleState = {
  nextRunAt: string | null;
  lastTickAt: string | null;
  retryCount: number;
  retryCounts: Record<string, number>;
  regularRunAt: string | null;
  retryAt: string | null;
  records: ScheduleRecord[];
};

export function emptySchedule(): ScheduleState {
  return { nextRunAt: null, lastTickAt: null, retryCount: 0, retryCounts: {}, regularRunAt: null, retryAt: null, records: [] };
}

export function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}

export function hoursLate(now: string, due: string): number {
  return (Date.parse(now) - Date.parse(due)) / 3_600_000;
}

export type ScheduleTick = {
  action: ScheduleAction | "idle";
  attention: string | null;
  record: ScheduleRecord | null;
  scan: ScanJob | null;
  scanStarted: boolean;
  scans: { scan: ScanJob; started: boolean }[];
  schedule: ScheduleState;
};

function recordOf(
  orgId: string,
  at: string,
  action: ScheduleAction,
  subscriptionId: string | null,
  reason: string | null,
  scanId: string | null,
  sequence: number,
): ScheduleRecord {
  const record: ScheduleRecord = {
    id: `sched-${sequence}`,
    orgId,
    subscriptionId,
    at,
    action,
    reason,
    scanId,
  };
  return record;
}

function healthyConnections(connections: Connection[]): Connection[] {
  return connections.filter((connection) => connection.healthy);
}

export function decideTick(input: {
  now: string;
  enabled: boolean;
  intervalHours: number;
  retryLimit: number;
  nextRunAt: string | null;
  retryCount: number;
  connection: Connection | null;
  running: boolean;
  lastSystemFailed: boolean;
}): { action: ScheduleAction | "idle"; reason: string | null; attention: string | null } {
  if (!input.enabled) {
    return { action: "idle", reason: null, attention: null };
  }
  if (input.nextRunAt && Date.parse(input.now) < Date.parse(input.nextRunAt)) {
    return { action: "idle", reason: null, attention: null };
  }
  if (!input.connection) {
    return {
      action: "skipped_broken",
      reason: "connection needs attention",
      attention: "connection needs attention",
    };
  }
  if (input.running) {
    return { action: "skipped_overlap", reason: "a scan is already running", attention: null };
  }
  if (input.lastSystemFailed && input.retryCount < input.retryLimit) {
    return { action: "retried", reason: `retry ${input.retryCount + 1} of ${input.retryLimit}`, attention: null };
  }
  if (input.nextRunAt && hoursLate(input.now, input.nextRunAt) >= input.intervalHours) {
    return { action: "missed", reason: "scheduled run was missed", attention: null };
  }
  if (!input.nextRunAt || Date.parse(input.now) >= Date.parse(input.nextRunAt)) {
    return { action: "started", reason: null, attention: null };
  }
  return { action: "idle", reason: null, attention: null };
}

export class ScanScheduler {
  constructor(
    private readonly store: MemoryStore,
    private readonly runner: ScanRunner,
    private readonly clock: Clock = systemClock,
    private readonly log: LogSink = silentLog,
  ) {}

  applySettings(orgId: string, now: string = this.clock()): ScheduleState {
    const org = this.store.org(orgId);
    if (!org.settings.scanScheduleEnabled) {
      org.schedule.nextRunAt = null;
      org.schedule.regularRunAt = null;
      org.schedule.retryAt = null;
      return org.schedule;
    }
    org.schedule.regularRunAt = addHours(now, org.settings.scanIntervalHours);
    org.schedule.retryAt = null;
    org.schedule.nextRunAt = org.schedule.regularRunAt;
    return org.schedule;
  }

  tick(orgId: string, now: string = this.clock()): ScheduleTick {
    const org = this.store.org(orgId);
    org.schedule.lastTickAt = now;
    const healthy = healthyConnections(org.connections);
    const expired = this.runner.expireStaleScans(orgId, now);
    const activeSubscriptions = new Set<string>();
    const lastSystemStatus = new Map<string, ScanJob["status"]>();
    for (const scan of org.scans) {
      if (scan.status === "queued" || scan.status === "running") {
        activeSubscriptions.add(scan.subscriptionId);
      }
      if (scan.actor === "system") {
        lastSystemStatus.set(scan.subscriptionId, scan.status);
      }
    }
    const connection = healthy[0] ?? null;
    const subscriptionId = connection?.subscriptionId ?? org.connections[0]?.subscriptionId ?? null;
    const failedRetryable = healthy.filter(
      (item) => lastSystemStatus.get(item.subscriptionId) === "failed",
    );
    const retryCountOf = (item: Connection) => org.schedule.retryCounts[item.subscriptionId] ?? 0;
    const retryable = failedRetryable.filter((item) => retryCountOf(item) < org.settings.scanRetryLimit);
    const retryDue = org.schedule.retryAt !== null && Date.parse(now) >= Date.parse(org.schedule.retryAt);
    if (retryDue && retryable.length === 0 && org.schedule.regularRunAt) {
      org.schedule.retryAt = null;
      org.schedule.nextRunAt = org.schedule.regularRunAt;
    }
    const decision = decideTick({
      now,
      enabled: org.settings.scanScheduleEnabled,
      intervalHours: org.settings.scanIntervalHours,
      retryLimit: org.settings.scanRetryLimit,
      nextRunAt: org.schedule.nextRunAt,
      retryCount: failedRetryable.length > 0 ? Math.min(...failedRetryable.map(retryCountOf)) : 0,
      connection,
      running:
        healthy.length > 0 && healthy.every((item) => activeSubscriptions.has(item.subscriptionId)),
      lastSystemFailed: failedRetryable.length > 0,
    });
    const attention =
      expired.length > 0 ? "scan stuck: a scan ran past the timeout and was marked failed" : decision.attention;
    if (decision.action === "idle") {
      emitDecision(this.log, { decision: "idle", orgId, at: now });
      return {
        action: "idle",
        attention,
        record: null,
        scan: null,
        scanStarted: false,
        scans: [],
        schedule: org.schedule,
      };
    }
    const action = decision.action;
    const scans: ScheduleTick["scans"] = [];
    if ((action === "started" || action === "retried" || action === "missed") && healthy.length > 0) {
      const targets = action === "retried" ? retryable : healthy;
      for (const item of targets) {
        const started = this.runner.start({ orgId, subscriptionId: item.subscriptionId, actor: "system" });
        scans.push({ scan: started.job, started: started.started });
      }
      if (action === "retried") {
        for (const item of targets) {
          org.schedule.retryCounts[item.subscriptionId] = retryCountOf(item) + 1;
        }
      } else {
        org.schedule.retryCounts = {};
      }
      org.schedule.retryCount = Math.max(0, ...Object.values(org.schedule.retryCounts));
    }
    if (action === "retried") {
      org.schedule.retryAt = null;
      org.schedule.nextRunAt = org.schedule.regularRunAt;
    } else {
      org.schedule.regularRunAt = addHours(now, org.settings.scanIntervalHours);
      org.schedule.retryAt = null;
      org.schedule.nextRunAt = org.schedule.regularRunAt;
    }
    const records = (scans.length > 0 ? scans : [null]).map((target) =>
      recordOf(
        orgId,
        now,
        action,
        target?.scan.subscriptionId ?? subscriptionId,
        decision.reason,
        target?.scan.id ?? null,
        this.store.nextSequence(orgId, "schedule"),
      ),
    );
    org.schedule.records.push(...records);
    if (org.schedule.records.length > MAX_SCHEDULE_RECORDS) {
      org.schedule.records.splice(0, org.schedule.records.length - MAX_SCHEDULE_RECORDS);
    }
    emitDecision(this.log, {
      decision: action,
      orgId,
      at: now,
      ...(scans[0] ? { scanId: scans[0].scan.id } : {}),
    });
    return {
      action,
      attention,
      record: records[0] ?? null,
      scan: scans[0]?.scan ?? null,
      scanStarted: scans[0]?.started ?? false,
      scans,
      schedule: org.schedule,
    };
  }
}
