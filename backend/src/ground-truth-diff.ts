import type { Finding, Inventory } from "@farside/scan-contracts";
import type { CoverageEntry } from "./coverage.js";
import type { GroundTruthManifest } from "./inventory.js";
import { LAUNCH_RESOURCE_TYPES } from "./resource-graph.js";

/**
 * Diff of a scan against `docs/azure/ground-truth.json` (#123, #155, #63). Live resources are
 * matched to manifest items by resource name, because the seed names each resource after its
 * item id. Subscription aliases ("main", "empty-no-budget") map to real ids at run time.
 */
export type GroundTruthCheck = {
  checkId: string;
  positives: string[];
  negatives: string[];
  emptySubscriptionId?: string;
  exception: { status: string; reason: string } | null;
};

export type ManifestWithChecks = GroundTruthManifest & { checks: GroundTruthCheck[] };

export type ScanOutput = { findings: readonly Finding[]; inventory: Inventory; coverage: readonly CoverageEntry[] };

export type CheckDiff =
  | { checkId: string; result: "pass" | "fail"; defects: string[] }
  | { checkId: string; skipped: string };

/** Subscription alias in the manifest → the real subscription id used for the run. */
export type SubscriptionMap = Record<string, string | undefined>;

const ALL_RESOURCES = "azure-inventory-all-resources";

function nameOf(uri: string): string {
  return (uri.split("/").pop() ?? uri).toLowerCase();
}

function findingName(finding: Finding): string | null {
  const fields = finding.evidence.fields;
  const uri = typeof fields.resourceUri === "string" ? fields.resourceUri : fields.resourceId;
  return typeof uri === "string" && uri.length > 0 ? nameOf(uri) : null;
}

function same(left: string, right: string | undefined): boolean {
  return right !== undefined && left.toLowerCase() === right.toLowerCase();
}

function inSubscription(uri: string, subscriptionId: string | undefined): boolean {
  return same(uri.split("/")[2] ?? "", subscriptionId);
}

export function diffCheck(
  check: GroundTruthCheck,
  manifest: GroundTruthManifest,
  output: ScanOutput,
  subscriptions: SubscriptionMap,
): CheckDiff {
  if (check.exception) {
    return { checkId: check.checkId, skipped: `${check.exception.status}: ${check.exception.reason}` };
  }
  if (check.emptySubscriptionId && !subscriptions[check.emptySubscriptionId]) {
    return { checkId: check.checkId, skipped: `subscription '${check.emptySubscriptionId}' was not part of the run` };
  }
  const items = new Map(manifest.items.map((item) => [item.id, item]));
  const defects: string[] = [];
  const findings = output.findings.filter((finding) => finding.checkId === check.checkId);
  const inventoryNames = new Set(output.inventory.resources.map((resource) => nameOf(resource.resourceUri)));
  const subscriptionFinding = (alias: string) =>
    findings.find((finding) => same(finding.scope.subscriptionOrProject, subscriptions[alias]));

  for (const entry of output.coverage) {
    const alias = Object.keys(subscriptions).find((key) => same(entry.subscriptionOrProject, subscriptions[key]));
    if (entry.checkId === check.checkId && alias === "main" && entry.state !== "assessed") {
      defects.push(`coverage on main is ${entry.state}`);
    }
  }

  for (const id of check.positives) {
    const item = items.get(id);
    if (check.checkId === ALL_RESOURCES) {
      if (!inventoryNames.has(id.toLowerCase())) {
        defects.push(`${id}: missing from inventory`);
      }
      continue;
    }
    const hit = findings.find((finding) => findingName(finding) === id.toLowerCase());
    if (!hit) {
      defects.push(`${id}: no finding (expected fail)`);
    } else if (hit.result !== "fail") {
      defects.push(`${id}: ${hit.result} (expected fail)`);
    }
    if (item && !subscriptions[item.subscription]) {
      defects.push(`${id}: subscription '${item.subscription}' was not part of the run`);
    }
  }

  for (const id of check.negatives) {
    const item = items.get(id);
    if (item?.type === "Microsoft.Consumption/budgets") {
      const hit = subscriptionFinding(item.subscription);
      if (hit?.result !== "pass") {
        defects.push(`${id}: ${hit?.result ?? "no finding"} (expected pass)`);
      }
      continue;
    }
    const hit = findings.find((finding) => findingName(finding) === id.toLowerCase());
    if (!inventoryNames.has(id.toLowerCase())) {
      defects.push(`${id}: missing from inventory`);
    } else if (hit?.result !== "pass") {
      defects.push(`${id}: ${hit?.result ?? "no finding"} (expected pass)`);
    }
  }

  if (check.emptySubscriptionId) {
    const empty = subscriptions[check.emptySubscriptionId];
    if (check.checkId === ALL_RESOURCES) {
      const count = output.inventory.resources.filter((resource) => inSubscription(resource.resourceUri, empty)).length;
      if (count > 0) {
        defects.push(`${check.emptySubscriptionId}: ${count} resources (expected none)`);
      }
    } else {
      const hit = subscriptionFinding(check.emptySubscriptionId);
      if (hit?.result !== "fail") {
        defects.push(`${check.emptySubscriptionId}: ${hit?.result ?? "no finding"} (expected fail)`);
      }
    }
  }

  return { checkId: check.checkId, result: defects.length === 0 ? "pass" : "fail", defects };
}

export type InventoryDiff = {
  result: "pass" | "fail";
  expected: number;
  observed: number;
  missing: string[];
  unexpected: string[];
  ownerMismatch: string[];
};

/** Launch-type resources in the seeded subscriptions against the manifest (#63). */
export function diffInventory(
  manifest: GroundTruthManifest,
  inventory: Inventory,
  subscriptions: SubscriptionMap,
): InventoryDiff {
  const launchTypes = new Set<string>(LAUNCH_RESOURCE_TYPES.map((type) => type.toLowerCase()));
  const expected = manifest.items.filter(
    (item) => launchTypes.has(item.type.toLowerCase()) && subscriptions[item.subscription],
  );
  const observed = inventory.resources.filter((resource) =>
    Object.values(subscriptions).some((id) => inSubscription(resource.resourceUri, id)),
  );
  const byName = new Map(observed.map((resource) => [nameOf(resource.resourceUri), resource]));
  const expectedNames = new Set(expected.map((item) => item.id.toLowerCase()));
  const ownerKey = manifest.ownerTagKey;
  const missing: string[] = [];
  const ownerMismatch: string[] = [];
  for (const item of expected) {
    const live = byName.get(item.id.toLowerCase());
    if (!live) {
      missing.push(item.id);
      continue;
    }
    if (!inSubscription(live.resourceUri, subscriptions[item.subscription])) {
      missing.push(`${item.id} (wrong subscription)`);
      continue;
    }
    const want = item.tags[ownerKey] ?? null;
    const got = live.ownerTag ?? null;
    if (want !== got) {
      ownerMismatch.push(`${item.id}: owner ${got ?? "none"} (expected ${want ?? "none"})`);
    }
  }
  const unexpected = [...byName.keys()].filter((name) => !expectedNames.has(name)).sort();
  return {
    result: missing.length + unexpected.length + ownerMismatch.length === 0 ? "pass" : "fail",
    expected: expected.length,
    observed: observed.length,
    missing,
    unexpected,
    ownerMismatch,
  };
}
