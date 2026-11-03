import type { Inventory } from "@farside/scan-contracts";
import type { Clock } from "../clock.js";
import { coverageFromHarvest } from "../coverage.js";
import type { ResourceFacts } from "../facts.js";
import { applyOwnerTag } from "../inventory.js";
import { providerFor } from "./registry.js";
import type { Harvester } from "./types.js";

export function fixtureHarvester(
  inventory: Inventory,
  facts: ResourceFacts[] = [],
  clock?: Clock,
): Harvester {
  return {
    async harvest(input) {
      const provider = providerFor(inventory.cloud);
      const coverage = coverageFromHarvest(
        [input.subscriptionId],
        provider.launchCheckIds,
        provider.harvestAssessedCheckIds,
      );
      return {
        inventory: applyOwnerTag(
          clock ? { ...inventory, observedAt: clock() } : inventory,
          input.settings.ownerTagKey,
        ),
        coverage,
        coveredScopes: coverage
          .filter((entry) => entry.state === "assessed")
          .map((entry) => entry.id),
        facts,
      };
    },
  };
}
