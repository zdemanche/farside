import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyse, mulberry32, parseArgs, runSoak, simulate } from "./soak.mjs";

const T0 = "2026-01-06T00:00:00.000Z";
const at = (hours) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const scan = (id, hours, status = "succeeded", extra = {}) => ({
  id,
  subscriptionId: "main",
  actor: "system",
  status,
  createdAt: at(hours),
  startedAt: at(hours),
  finishedAt: status === "running" ? null : at(hours + 0.1),
  error: status === "failed" ? "boom" : null,
  ...extra,
});
const window = { since: T0, until: at(6 * 24 + 1), intervalHours: 24 };

describe("soak analysis", () => {
  it("passes one scheduled run per interval", () => {
    const scans = Array.from({ length: 7 }, (_, day) => scan(`scan-${day + 1}`, day * 24 + 0.25));
    const result = analyse({ ...window, scans, records: [] });
    expect(result).toMatchObject({ pass: true, counts: { expected: 7, scheduled: 7, missed: 0, duplicates: 0 } });
  });

  it("counts a missing day as missed", () => {
    const scans = [0, 1, 3, 4, 5, 6].map((day) => scan(`scan-${day}`, day * 24));
    const result = analyse({ ...window, scans, records: [] });
    expect(result.pass).toBe(false);
    expect(result.counts.missed).toBe(1);
  });

  it("counts a second scheduled run in one interval as a duplicate, but not a retry", () => {
    const scans = [...Array.from({ length: 7 }, (_, day) => scan(`scan-${day}`, day * 24)), scan("scan-dup", 30), scan("scan-retry", 49)];
    scans.find((item) => item.id === "scan-1").status = "failed";
    const records = [{ scanId: "scan-retry", action: "retried", at: at(49) }];
    const result = analyse({ ...window, scans: scans.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), records });
    expect(result.counts.duplicates).toBe(1);
    expect(result.counts.retries).toBe(1);
  });

  it("fails a run whose retries all failed, and an overlap", () => {
    const scans = [
      scan("scan-0", 0, "failed"),
      scan("scan-r1", 1, "failed"),
      ...Array.from({ length: 6 }, (_, day) => scan(`scan-${day + 1}`, (day + 1) * 24)),
      scan("scan-overlap", 24.05),
    ];
    const records = [{ scanId: "scan-r1", action: "retried", at: at(1) }, { scanId: "scan-overlap", action: "retried", at: at(24.05) }];
    const result = analyse({ ...window, scans, records });
    expect(result.counts.failed).toBe(1);
    expect(result.counts.overlaps).toBe(1);
    expect(result.pass).toBe(false);
  });

  it("ignores user scans and reports late runs from scheduler records", () => {
    const scans = [
      ...Array.from({ length: 7 }, (_, day) => scan(`scan-${day}`, day * 24)),
      scan("scan-user", 12, "succeeded", { actor: "user" }),
    ];
    const result = analyse({ ...window, scans, records: [{ scanId: "scan-3", action: "missed", at: at(72) }] });
    expect(result.pass).toBe(true);
    expect(result.counts.late).toBe(1);
  });
});

describe("simulated soak on the production tick path", () => {
  it("runs a clean week: one scan a day, nothing missed, failed or duplicated", async () => {
    const result = await simulate(parseArgs([]));
    expect(result.pass).toBe(true);
    expect(result.counts).toMatchObject({ expected: 7, scheduled: 7, succeeded: 7, missed: 0, failed: 0, duplicates: 0, overlaps: 0 });
    expect(result.ticks).toBe(7 * 96);
    expect(result.tickErrors).toBe(0);
  });

  it("recovers injected failures by retrying and reports a run that never recovers", async () => {
    const result = await simulate(parseArgs(["--failure-rate", "0.5", "--seed", "3"]));
    expect(result.injectedFailures).toBeGreaterThan(0);
    expect(result.counts.retries).toBeGreaterThan(0);
    expect(result.counts.failed).toBeGreaterThan(0);
    expect(result.pass).toBe(false);
  });

  it("detects missed runs when ticks are dropped", async () => {
    const result = await simulate(parseArgs(["--interval-hours", "1", "--cycles", "24", "--drop-ticks", "0.6", "--seed", "1"]));
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.counts.missed).toBeGreaterThan(0);
    expect(result.pass).toBe(false);
  });

  it("is deterministic for a seed", () => {
    const a = mulberry32(9);
    const b = mulberry32(9);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("soak record", () => {
  it("writes a dated pass/fail record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "farside-soak-"));
    const { record, file, exitCode } = await runSoak({ argv: ["--cycles", "2"], outDir: dir, now: "2026-11-09T00:00:00.000Z" });
    expect(exitCode).toBe(0);
    expect(file).toBe(join(dir, "2026-11-09-simulated.json"));
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ kind: "farside-soak/1", mode: "simulated", result: "pass" });
    expect(record.note).toMatch(/Not the unattended week/);
  });

  it("skips live mode with exit 0 when the API is not configured", async () => {
    const calls = [];
    const { record, exitCode } = await runSoak({ argv: ["--live", "--out", "-"], env: {}, fetchImpl: async (...args) => calls.push(args) });
    expect(exitCode).toBe(0);
    expect(record).toMatchObject({ mode: "live-skipped", result: "skipped" });
    expect(calls).toEqual([]);
  });

  it("analyses live history read from the API", async () => {
    const scans = Array.from({ length: 3 }, (_, day) => scan(`scan-${day + 1}`, day * 24 + 0.25));
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      const body = path.endsWith("/schedule") ? { records: [], intervalHours: 24 } : { scans };
      return { status: 200, json: async () => body };
    };
    const { record, exitCode } = await runSoak({
      argv: ["--live", "--since", T0, "--until", at(48.5), "--out", "-"],
      env: { FARSIDE_API_URL: "https://api.test", FARSIDE_ORG: "org-a" },
      fetchImpl,
    });
    expect(record).toMatchObject({ mode: "live", result: "pass", counts: { scheduled: 3, missed: 0 } });
    expect(exitCode).toBe(0);
  });

  it("rejects bad arguments", () => {
    expect(() => parseArgs(["--cycles", "-1"])).toThrow();
    expect(() => parseArgs(["--nope"])).toThrow(/unknown/);
  });
});
