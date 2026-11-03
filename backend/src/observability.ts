import type { Writable } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import type { DeletionRecord } from "./offboard.js";

export type LogSink = Pick<FastifyBaseLogger, "info" | "error">;

export const silentLog: LogSink = {
  info: () => undefined,
  error: () => undefined,
};

export type LoggerOptions = { level?: string; stream?: Writable };

const REDACTED_PATHS = [
  "req.headers.authorization",
  'req.headers["x-farside-org"]',
  'req.headers["x-farside-actor"]',
  'req.headers["x-farside-operator"]',
  "req.body",
  "res.body",
  "body",
  "*.body",
  "err.*.body",
  "err.cause.body",
  "err.response.body",
];

export function loggerFromEnv(): LoggerOptions {
  return { level: process.env.FARSIDE_LOG_LEVEL || "info" };
}

export function pinoOptions(options: LoggerOptions | undefined) {
  if (!options) {
    return false;
  }
  return {
    level: options.level ?? "info",
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    ...(options.stream ? { stream: options.stream } : {}),
  };
}

export function audit(
  log: LogSink,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  log.info({ event, ...fields }, event);
}

export function auditRetention(
  log: LogSink,
  records: readonly DeletionRecord[],
): void {
  for (const record of records) {
    audit(log, "org.offboard", {
      orgId: record.orgId,
      actorId: record.requestedBy,
      trigger: record.trigger,
    });
  }
}
