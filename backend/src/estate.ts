import { CLOUDS, type Cloud } from "@farside/scan-contracts";
import { matchesCloud } from "./cloud.js";
import type { CoverageEntry } from "./coverage.js";
import { coverageHealth } from "./coverage.js";
import { noOwnerTotal } from "./inventory.js";
import type { OrgView } from "./store.js";

export type EstateOverview = {
  empty: boolean;
  resourceTotal: number;
  noOwnerTotal: number;
  coverage: { assessed: number; unassessed: number; undetermined: number };
  healthScore: number | null;
};

export function coverageCounts(entries: CoverageEntry[]): EstateOverview["coverage"] {
  return {
    assessed: entries.filter((entry) => entry.state === "assessed").length,
    unassessed: entries.filter((entry) => entry.state === "unassessed").length,
    undetermined: entries.filter((entry) => entry.state === "undetermined").length,
  };
}

export function inventoriesFor(org: OrgView, cloud?: Cloud) {
  const stored = CLOUDS.flatMap((name) => {
    const inventory = org.inventories[name];
    return inventory ? [inventory] : [];
  });
  const pool = stored.length > 0 ? stored : org.inventory ? [org.inventory] : [];
  return pool.filter((inventory) => matchesCloud(inventory.cloud, cloud));
}

export function estateOverview(org: OrgView, cloud?: Cloud): EstateOverview {
  const inventories = inventoriesFor(org, cloud);
  const coverage = org.coverage.filter((entry) => matchesCloud(entry.cloud, cloud));
  const findings = org.findings.filter((finding) => matchesCloud(finding.scope.cloud, cloud));
  if (inventories.length === 0) {
    return {
      empty: true,
      resourceTotal: 0,
      noOwnerTotal: 0,
      coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
      healthScore: null,
    };
  }
  return {
    empty: false,
    resourceTotal: inventories.reduce((total, inventory) => total + inventory.resources.length, 0),
    noOwnerTotal: inventories.reduce((total, inventory) => total + noOwnerTotal(inventory).total, 0),
    coverage: coverageCounts(coverage),
    healthScore: coverageHealth(coverage, findings).score,
  };
}
