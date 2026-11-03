import type { InventoryRecord } from "@farside/scan-contracts";
import { subscriptionOf } from "../providers/arm.js";
import { buildFinding, checkDefinition, defineAzureCheck, fail, pass, undetermined } from "./define.js";

export const ALL_RESOURCES = "azure-inventory-all-resources";
export const NO_OWNER_TAG = "azure-inventory-no-owner-tag";

export const ARG_CLOSER = "Grant Reader on that subscription and a successful ARG query";
export const OWNER_TAG_CLOSER = "Set the owner tag key in Settings";
export const TAGS_CLOSER = "A Resource Graph row for that type that includes tags";

function countByTypeField(resources: InventoryRecord[]): string {
  const counts = new Map<string, number>();
  for (const resource of resources) {
    counts.set(resource.resourceType, (counts.get(resource.resourceType) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}:${count}`)
    .join(",");
}

function groupBySubscription(
  resources: InventoryRecord[],
  incomplete: ReadonlySet<string>,
): Map<string, InventoryRecord[]> {
  const bySubscription = new Map<string, InventoryRecord[]>();
  for (const resource of resources) {
    const subscription = subscriptionOf(resource.resourceUri);
    if (subscription) {
      const group = bySubscription.get(subscription) ?? [];
      group.push(resource);
      bySubscription.set(subscription, group);
    }
  }
  for (const subscription of incomplete) {
    if (!bySubscription.has(subscription)) {
      bySubscription.set(subscription, []);
    }
  }
  return bySubscription;
}

export const checkAllResources = checkDefinition({ checkId: ALL_RESOURCES, cloud: "azure" }, (inventory, facts) => {
  const incomplete = new Set(
    facts
      .filter((row) => row.fields.argIncomplete === true)
      .map((row) => subscriptionOf(row.resourceUri))
      .filter(Boolean),
  );
  return [...groupBySubscription(inventory.resources, incomplete).entries()].map(([subscription, resources]) => {
    const meta = { checkId: ALL_RESOURCES, cloud: "azure" as const };
    if (incomplete.has(subscription)) {
      return buildFinding(
        meta,
        subscription,
        undetermined(ARG_CLOSER, {
          subscriptionId: subscription,
          resourceId: null,
          type: null,
          location: null,
          countByType: null,
        }),
      );
    }
    const first = resources[0];
    return buildFinding(
      meta,
      subscription,
      pass({
        subscriptionId: subscription,
        resourceId: first?.resourceUri ?? subscription,
        type: first?.resourceType ?? "all",
        location: first?.region ?? "eastus",
        countByType: countByTypeField(resources),
        resourceCount: resources.length,
      }),
    );
  });
});

function firstPerScope(resources: InventoryRecord[], scopeOf: (resourceUri: string) => string): InventoryRecord[] {
  const firsts = new Map<string, InventoryRecord>();
  for (const resource of resources) {
    const scope = scopeOf(resource.resourceUri);
    if (scope && !firsts.has(scope)) {
      firsts.set(scope, resource);
    }
  }
  return [...firsts.values()];
}

export const checkNoOwnerTag = defineAzureCheck({
  checkId: NO_OWNER_TAG,
  select: (resources, { settings, scopeOf }) =>
    settings.ownerTagKey.length > 0 ? resources : firstPerScope(resources, scopeOf),
  readFacts: (_resource, fields) => ({ tagsAbsent: fields?.tagsPresent === false }),
  decide: ({ tagsAbsent }, { resource, settings }) => {
    const ownerTagKey = settings.ownerTagKey;
    if (ownerTagKey.length === 0) {
      return undetermined(OWNER_TAG_CLOSER, {
        resourceId: null,
        type: null,
        tagsPresent: null,
        ownerTagKey: null,
        ownerTagValue: null,
      });
    }
    const evidence = (tagsPresent: boolean, ownerTagValue: string | null) => ({
      resourceId: resource.resourceUri,
      type: resource.resourceType,
      tagsPresent,
      ownerTagKey,
      ownerTagValue,
    });
    if (tagsAbsent) {
      return undetermined(TAGS_CLOSER, evidence(false, null));
    }
    const owner = resource.ownerTag;
    return owner ? pass(evidence(true, owner)) : fail(evidence(true, owner ?? null));
  },
});
