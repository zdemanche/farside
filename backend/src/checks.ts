import type { Finding, Inventory } from "@farside/scan-contracts";
import { acceptFinding, indexFacts, type CheckDefinition } from "./checks/define.js";
import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import { allProviders, findCheck } from "./providers/index.js";
import { scopeOf } from "./scope.js";
import type { OrgSettings } from "./settings.js";
import { DEFAULT_SETTINGS } from "./settings.js";

export * from "./checks/azure-inventory.js";
export * from "./checks/azure-lifecycle.js";
export * from "./checks/azure-resilience.js";
export * from "./checks/azure-waste.js";
export { acceptFinding } from "./checks/define.js";
export { HARVEST_DRIVEN_CHECK_IDS } from "./providers/launch-ids.js";
export { registeredCheckIds } from "./providers/index.js";

export class UnregisteredCheckError extends Error {
  constructor(checkId: string) {
    super(`unregistered check '${checkId}' cannot run`);
    this.name = "UnregisteredCheckError";
  }
}

export const CHECK_REGISTRY: Record<string, CheckDefinition> = Object.fromEntries(
  allProviders().flatMap((provider) => provider.checks.map((check) => [check.checkId, check])),
);

export function runChecks(input: {
  inventory: Inventory;
  facts: ResourceFacts[];
  checkIds: string[];
  unreadSubscriptions?: string[];
  scopes?: string[];
  settings?: OrgSettings;
}): { findings: Finding[]; coverage: CoverageEntry[] } {
  const { inventory, facts } = input;
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const rows = indexFacts(facts);
  const findings: Finding[] = [];
  const coverage: CoverageEntry[] = [];
  const scopes = [
    ...new Set([
      ...inventory.resources.map((resource) => scopeOf(inventory.cloud, resource.resourceUri)),
      ...(input.scopes ?? []),
    ]),
  ].filter(Boolean);

  for (const checkId of input.checkIds) {
    const check = findCheck(checkId);
    if (!check) {
      throw new UnregisteredCheckError(checkId);
    }
    const produced = check(inventory, facts, settings, rows).map(acceptFinding);
    findings.push(...produced);
    for (const subscriptionOrProject of scopes) {
      const scoped = produced.filter((finding) => finding.scope.subscriptionOrProject === subscriptionOrProject);
      const closer = scoped.find((finding) => finding.result === "undetermined")?.closer;
      const determinate = scoped.some((finding) => finding.result !== "undetermined");
      const undetermined = scoped.length > 0 && !determinate;
      coverage.push(
        recordCoverageScope({
          subscriptionOrProject,
          checkId,
          state: undetermined ? "undetermined" : "assessed",
          ...(undetermined && closer ? { closer } : {}),
        }),
      );
    }
    for (const unread of input.unreadSubscriptions ?? []) {
      coverage.push(
        recordCoverageScope({
          subscriptionOrProject: unread,
          checkId,
          state: "unassessed",
          causeId: "failed_call",
        }),
      );
    }
  }
  return { findings, coverage };
}
