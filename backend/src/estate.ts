import type { CoverageEntry } from "./coverage.js";
import { noOwnerTotal } from "./inventory.js";
import type { OrgState } from "./store.js";

export type EstateOverview = {
  empty: boolean;
  resourceTotal: number;
  noOwnerTotal: number;
  coverage: { assessed: number; unassessed: number; undetermined: number };
  healthScore: null;
};

export function coverageCounts(entries: CoverageEntry[]): EstateOverview["coverage"] {
  return {
    assessed: entries.filter((entry) => entry.state === "assessed").length,
    unassessed: entries.filter((entry) => entry.state === "unassessed").length,
    undetermined: entries.filter((entry) => entry.state === "undetermined").length,
  };
}

export function estateOverview(org: OrgState): EstateOverview {
  if (!org.inventory) {
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
    resourceTotal: org.inventory.resources.length,
    noOwnerTotal: noOwnerTotal(org.inventory).total,
    coverage: coverageCounts(org.coverage),
    healthScore: null,
  };
}
