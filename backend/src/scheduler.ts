import { systemClock, type Clock } from "./clock.js";
import { emitDecision, silentLog, type LogSink } from "./observability.js";
import { asMutable } from "./readonly.js";
import type { Connection, OrgRepository } from "./repository.js";
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

type ScheduleFields = Pick<
  ScheduleState,
  "lastTickAt" | "nextRunAt" | "regularRunAt" | "retryAt" | "retryCount" | "retryCounts"
>;

function scheduleFields(schedule: ScheduleState): ScheduleFields {
  const { lastTickAt, nextRunAt, regularRunAt, retryAt, retryCount, retryCounts } = schedule;
  return { lastTickAt, nextRunAt, regularRunAt, retryAt, retryCount, retryCounts };
}

export class ScanScheduler {
  constructor(
    private readonly store: OrgRepository,
    private readonly runner: ScanRunner,
    private readonly clock: Clock = systemClock,
    private readonly log: LogSink = silentLog,
  ) {}

  async applySettings(orgId: string, now: string = this.clock()): Promise<ScheduleState> {
    const { settings } = await this.store.read(orgId, "settings");
    return this.store.updateSchedule(orgId, (schedule) => {
      if (!settings.scanScheduleEnabled) {
        schedule.nextRunAt = null;
        schedule.regularRunAt = null;
        schedule.retryAt = null;
        return;
      }
      schedule.regularRunAt = addHours(now, settings.scanIntervalHours);
      schedule.retryAt = null;
      schedule.nextRunAt = schedule.regularRunAt;
    });
  }

  async tick(orgId: string, now: string = this.clock()): Promise<ScheduleTick> {
    const expired = await this.runner.expireStaleScans(orgId, now);
    const org = await this.store.read(orgId, "settings", "connections", "scans", "schedule");
    const { settings } = org;
    const schedule = structuredClone(asMutable<ScheduleState>(org.schedule));
    schedule.lastTickAt = now;
    const healthy = healthyConnections(asMutable<Connection[]>(org.connections));
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
    const retryCountOf = (item: Connection) => schedule.retryCounts[item.subscriptionId] ?? 0;
    const retryable = failedRetryable.filter((item) => retryCountOf(item) < settings.scanRetryLimit);
    const retryDue = schedule.retryAt !== null && Date.parse(now) >= Date.parse(schedule.retryAt);
    if (retryDue && retryable.length === 0 && schedule.regularRunAt) {
      schedule.retryAt = null;
      schedule.nextRunAt = schedule.regularRunAt;
    }
    const decision = decideTick({
      now,
      enabled: settings.scanScheduleEnabled,
      intervalHours: settings.scanIntervalHours,
      retryLimit: settings.scanRetryLimit,
      nextRunAt: schedule.nextRunAt,
      retryCount: failedRetryable.length > 0 ? Math.min(...failedRetryable.map(retryCountOf)) : 0,
      connection,
      running:
        healthy.length > 0 && healthy.every((item) => activeSubscriptions.has(item.subscriptionId)),
      lastSystemFailed: failedRetryable.length > 0,
    });
    const attention =
      expired.length > 0 ? "scan stuck: a scan ran past the timeout and was marked failed" : decision.attention;
    if (decision.action === "idle") {
      const committed = await this.commit(orgId, schedule);
      emitDecision(this.log, { decision: "idle", orgId, at: now });
      return {
        action: "idle",
        attention,
        record: null,
        scan: null,
        scanStarted: false,
        scans: [],
        schedule: committed,
      };
    }
    const action = decision.action;
    const targets = action === "retried" ? retryable : healthy;
    const runs = (action === "started" || action === "retried" || action === "missed") && healthy.length > 0;
    if (runs) {
      if (action === "retried") {
        for (const item of targets) {
          schedule.retryCounts[item.subscriptionId] = retryCountOf(item) + 1;
        }
      } else {
        schedule.retryCounts = {};
      }
      schedule.retryCount = Math.max(0, ...Object.values(schedule.retryCounts));
    }
    if (action === "retried") {
      schedule.retryAt = null;
      schedule.nextRunAt = schedule.regularRunAt;
    } else {
      schedule.regularRunAt = addHours(now, settings.scanIntervalHours);
      schedule.retryAt = null;
      schedule.nextRunAt = schedule.regularRunAt;
    }
    await this.commit(orgId, schedule);
    const scans: ScheduleTick["scans"] = [];
    if (runs) {
      for (const item of targets) {
        const started = await this.runner.start({ orgId, subscriptionId: item.subscriptionId, actor: "system" });
        scans.push({ scan: started.job, started: started.started });
      }
    }
    const records: ScheduleRecord[] = [];
    for (const target of scans.length > 0 ? scans : [null]) {
      records.push(
        recordOf(
          orgId,
          now,
          action,
          target?.scan.subscriptionId ?? subscriptionId,
          decision.reason,
          target?.scan.id ?? null,
          await this.store.nextSequence(orgId, "schedule"),
        ),
      );
    }
    const committed = await this.store.updateSchedule(orgId, (live) => {
      live.records.push(...records);
      if (live.records.length > MAX_SCHEDULE_RECORDS) {
        live.records.splice(0, live.records.length - MAX_SCHEDULE_RECORDS);
      }
    });
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
      schedule: committed,
    };
  }

  private commit(orgId: string, schedule: ScheduleState): Promise<ScheduleState> {
    const fields = scheduleFields(schedule);
    return this.store.updateSchedule(orgId, (live) => {
      Object.assign(live, fields);
    });
  }
}
