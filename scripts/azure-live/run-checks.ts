import { diffCheck, diffInventory, type CheckDiff, type ManifestWithChecks } from "../../backend/src/ground-truth-diff.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };
import docAzureSpec from "../../docs/azure/launch-checks.json" with { type: "json" };
import { aliasIds, liveRunDate, liveScan, nowOf, out, runIfMain, startRun, writeRecord, type RunIo } from "./lib.js";

/**
 * #122/#123 non-cost checks, #154/#155 cost checks, and #63 inventory, each run live through
 * the production scan path and diffed against docs/azure/ground-truth.json. Writes
 * <date>-checks-noncost.json, <date>-checks-cost.json and <date>-inventory.json. A check is
 * `pass` only when the live findings agree with the manifest; `defects` feed #124 / #156.
 */
const MANIFEST = docAzureGroundTruth as unknown as ManifestWithChecks;
const SPEC = docAzureSpec as { checks: Array<{ id: string; group: string }> };

export function groupOf(checkId: string): string | undefined {
  return SPEC.checks.find((check) => check.id === checkId)?.group;
}

export function splitDiffs(diffs: CheckDiff[]) {
  const shape = (subset: CheckDiff[]) => ({
    checks: subset.flatMap((diff) => ("result" in diff ? [diff] : [])),
    skipped: subset.flatMap((diff) => ("skipped" in diff ? [{ checkId: diff.checkId, reason: diff.skipped }] : [])),
  });
  return {
    cost: shape(diffs.filter((diff) => groupOf(diff.checkId) === "cost")),
    noncost: shape(diffs.filter((diff) => groupOf(diff.checkId) !== "cost")),
  };
}

export async function main(_argv: string[] = [], io: RunIo = {}): Promise<number> {
  const runEnv = startRun(io);
  if (runEnv === "refused") {
    return 1;
  }
  if (!runEnv) {
    return 0;
  }
  const startedAt = nowOf(io);
  const liveRunAt = liveRunDate(startedAt);
  const scan = await liveScan(runEnv, io);
  const scans = scan.jobs.map(({ alias, job }) => ({
    subscription: alias,
    status: job.status,
    complete: job.complete,
    error: job.error,
    coverageSummary: job.coverageSummary,
  }));
  const diffs = MANIFEST.checks.map((check) => diffCheck(check, MANIFEST, scan.output, runEnv.subscriptions));
  const { cost, noncost } = splitDiffs(diffs);
  const base = { liveRunAt, startedAt: startedAt.toISOString(), source: "docs/azure/ground-truth.json", scans };
  const records = [
    { kind: "checks-noncost", issues: [122, 123], ...base, ...noncost },
    { kind: "checks-cost", issues: [154, 155], ...base, ...cost },
    { kind: "inventory", issues: [63], ...base, ...diffInventory(MANIFEST, scan.output.inventory, runEnv.subscriptions) },
  ];
  for (const record of records) {
    out(io, `wrote ${writeRecord(io, JSON.parse(aliasIds(runEnv, JSON.stringify(record))) as typeof record)}`);
  }
  const all = [...noncost.checks, ...cost.checks];
  const failing = all.filter((check) => check.result === "fail");
  out(io, `${all.length - failing.length} of ${all.length} checks agree with the ground truth; ${noncost.skipped.length + cost.skipped.length} skipped`);
  for (const check of failing) {
    out(io, aliasIds(runEnv, `  ${check.checkId}: ${check.defects.join("; ")}`));
  }
  out(io, "next: npm run azure-live:matrix to regenerate the spec and support matrix from these records");
  return scans.every((item) => item.status === "succeeded") ? 0 : 1;
}

await runIfMain(import.meta.url, (argv) => main(argv));
