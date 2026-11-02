import {
  assertValid,
  validateFinding,
  type Finding,
  type Inventory,
} from "@farside/scan-contracts";
import { AZURE_LAUNCH_CHECK_IDS, recordCoverageScope, type CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import { diskMonthlySavings } from "./savings.js";

export const UNATTACHED_DISKS = "azure-waste-unattached-disks";

export class UnregisteredCheckError extends Error {
  constructor(checkId: string) {
    super(`unregistered check '${checkId}' cannot run`);
    this.name = "UnregisteredCheckError";
  }
}

export function acceptFinding(finding: Finding): Finding {
  assertValid(validateFinding(finding));
  return finding;
}

function subscriptionOf(resourceUri: string): string {
  return resourceUri.split("/")[2] ?? "";
}

export function checkUnattachedDisks(inventory: Inventory, facts: ResourceFacts[]): Finding[] {
  const byUri = new Map(facts.map((row) => [row.resourceUri, row]));
  const disks = inventory.resources.filter(
    (resource) => resource.resourceType === "Microsoft.Compute/disks",
  );
  return disks.map((disk) => {
    const row = byUri.get(disk.resourceUri);
    const subscriptionOrProject = subscriptionOf(disk.resourceUri);
    const scope = {
      id: `${subscriptionOrProject}:${UNATTACHED_DISKS}`,
      cloud: "azure" as const,
      subscriptionOrProject,
    };
    const diskState = row?.fields.diskState;
    const sizeGb = row?.fields.sizeGb;
    if (typeof diskState !== "string") {
      return acceptFinding({
        checkId: UNATTACHED_DISKS,
        result: "undetermined",
        closer: "A disk read that includes diskState and managedBy",
        evidence: {
          fields: {
            diskId: disk.displayName,
            diskState: null,
            skuName: null,
            sizeGb: typeof sizeGb === "number" ? sizeGb : null,
            location: disk.region,
          },
        },
        scope,
      });
    }
    if (diskState === "Unattached") {
      if (typeof sizeGb !== "number" || sizeGb <= 0) {
        return acceptFinding({
          checkId: UNATTACHED_DISKS,
          result: "undetermined",
          closer: "A retail or agreement price row for the SKU in that region",
          evidence: {
            fields: {
              diskId: typeof row?.fields.diskId === "string" ? row.fields.diskId : disk.displayName,
              diskState,
              skuName: null,
              sizeGb: null,
              location: disk.region,
            },
          },
          scope,
        });
      }
      const savings = diskMonthlySavings(sizeGb);
      return acceptFinding({
        checkId: UNATTACHED_DISKS,
        result: "fail",
        evidence: {
          fields: {
            diskId: typeof row?.fields.diskId === "string" ? row.fields.diskId : disk.displayName,
            diskState,
            skuName: typeof row?.fields.skuName === "string" ? row.fields.skuName : null,
            sizeGb,
            location: disk.region,
            savingsBasis: savings.basis,
          },
        },
        scope,
        savings: { min: savings.min, max: savings.max, currency: savings.currency },
      });
    }
    return acceptFinding({
      checkId: UNATTACHED_DISKS,
      result: "pass",
      evidence: {
        fields: {
          diskId: typeof row?.fields.diskId === "string" ? row.fields.diskId : disk.displayName,
          diskState,
          skuName: null,
          sizeGb: typeof sizeGb === "number" ? sizeGb : null,
          location: disk.region,
        },
      },
      scope,
    });
  });
}

type CheckFn = (inventory: Inventory, facts: ResourceFacts[]) => Finding[];

export const CHECK_REGISTRY: Record<string, CheckFn> = {
  [UNATTACHED_DISKS]: checkUnattachedDisks,
};

export function runChecks(input: {
  inventory: Inventory;
  facts: ResourceFacts[];
  checkIds: string[];
  unreadSubscriptions?: string[];
}): { findings: Finding[]; coverage: CoverageEntry[] } {
  const findings: Finding[] = [];
  const coverage: CoverageEntry[] = [];
  const subscriptions = [
    ...new Set(input.inventory.resources.map((resource) => subscriptionOf(resource.resourceUri))),
  ].filter(Boolean);

  for (const checkId of input.checkIds) {
    if (!(AZURE_LAUNCH_CHECK_IDS as readonly string[]).includes(checkId)) {
      throw new UnregisteredCheckError(checkId);
    }
    const impl = CHECK_REGISTRY[checkId];
    if (!impl) {
      throw new UnregisteredCheckError(checkId);
    }
    findings.push(...impl(input.inventory, input.facts).map(acceptFinding));
    for (const subscriptionOrProject of subscriptions) {
      coverage.push(
        recordCoverageScope({
          subscriptionOrProject,
          checkId,
          state: "assessed",
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
