import type { Connection, MemoryStore } from "./store.js";
import type { ScanJob, ScanRunner } from "./scans.js";

export const DEFAULT_INTERVAL_HOURS = 24;
export const DEFAULT_RETRY_LIMIT = 3;
export const RETRY_DELAY_HOURS = 1;

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
  records: ScheduleRecord[];
};

export function emptySchedule(): ScheduleState {
  return { nextRunAt: null, lastTickAt: null, retryCount: 0, records: [] };
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
  schedule: ScheduleState;
};

function recordOf(
  orgId: string,
  at: string,
  action: ScheduleAction,
  subscriptionId: string | null,
  reason: string | null,
  scanId: string | null,
  index: number,
): ScheduleRecord {
  const record: ScheduleRecord = {
    id: `sched-${index + 1}`,
    orgId,
    subscriptionId,
    at,
    action,
    reason,
    scanId,
  };
  return record;
}

function healthyConnection(connections: Connection[]): Connection | null {
  return connections.find((connection) => connection.healthy) ?? null;
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
  ) {}

  applySettings(orgId: string, now: string): ScheduleState {
    const org = this.store.org(orgId);
    if (!org.settings.scanScheduleEnabled) {
      org.schedule.nextRunAt = null;
      return org.schedule;
    }
    org.schedule.nextRunAt = addHours(now, org.settings.scanIntervalHours);
    return org.schedule;
  }

  tick(orgId: string, now: string): ScheduleTick {
    const org = this.store.org(orgId);
    org.schedule.lastTickAt = now;
    const connection = healthyConnection(org.connections);
    const subscriptionId = connection?.subscriptionId ?? org.connections[0]?.subscriptionId ?? null;
    const lastSystem = [...org.scans].reverse().find((scan) => scan.actor === "system");
    const decision = decideTick({
      now,
      enabled: org.settings.scanScheduleEnabled,
      intervalHours: org.settings.scanIntervalHours,
      retryLimit: org.settings.scanRetryLimit,
      nextRunAt: org.schedule.nextRunAt,
      retryCount: org.schedule.retryCount,
      connection,
      running: subscriptionId ? Boolean(this.store.runningScan(orgId, subscriptionId)) : false,
      lastSystemFailed: lastSystem?.status === "failed",
    });
    if (decision.action === "idle") {
      return {
        action: "idle",
        attention: decision.attention,
        record: null,
        scan: null,
        scanStarted: false,
        schedule: org.schedule,
      };
    }
    let scan: ScanJob | null = null;
    let scanStarted = false;
    if (
      (decision.action === "started" || decision.action === "retried" || decision.action === "missed") &&
      subscriptionId
    ) {
      const started = this.runner.start({ orgId, subscriptionId, actor: "system" });
      scan = started.job;
      scanStarted = started.started;
      if (decision.action === "retried") {
        org.schedule.retryCount += 1;
      } else {
        org.schedule.retryCount = 0;
      }
      if (lastSystem?.status === "failed" && decision.action !== "retried") {
        org.schedule.retryCount = 0;
      }
      org.schedule.nextRunAt =
        decision.action === "retried"
          ? addHours(now, RETRY_DELAY_HOURS)
          : addHours(now, org.settings.scanIntervalHours);
    } else {
      org.schedule.nextRunAt = addHours(now, org.settings.scanIntervalHours);
    }
    const record = recordOf(
      orgId,
      now,
      decision.action,
      subscriptionId,
      decision.reason,
      scan?.id ?? null,
      org.schedule.records.length,
    );
    org.schedule.records.push(record);
    return {
      action: decision.action,
      attention: decision.attention,
      record,
      scan,
      scanStarted,
      schedule: org.schedule,
    };
  }
}
