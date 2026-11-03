import { checkAllResources, checkNoOwnerTag } from "../checks/azure-inventory.js";
import {
  checkExpiringAppCerts,
  checkExpiringGatewayCerts,
  checkRetiringSkus,
} from "../checks/azure-lifecycle.js";
import { checkDbZoneOrGeo, checkProdSqlBackup, checkProdVmBackup } from "../checks/azure-resilience.js";
import {
  checkEmptyPlans,
  checkIdleLoadBalancers,
  checkIdleNatGateways,
  checkOldSnapshots,
  checkStoppedVms,
  checkUnassociatedIps,
  checkUnattachedDisks,
} from "../checks/azure-waste.js";
import { factsFromManifest } from "../facts.js";
import { inventoryFromManifest, type GroundTruthManifest } from "../inventory.js";
import { OPTIONAL_AZURE_ROLES, REQUIRED_AZURE_ROLES } from "../roles.js";
import docAzureGroundTruth from "../../../docs/azure/ground-truth.json" with { type: "json" };
import { subscriptionOf } from "./arm.js";
import { collectAzureHarvests } from "./azure-harvests.js";
import { fixtureHarvester } from "./fixture-harvester.js";
import { AZURE_HARVEST_ASSESSED_CHECK_IDS, AZURE_LAUNCH_CHECK_IDS } from "./launch-ids.js";
import type { CloudProvider } from "./types.js";

export const azureProvider: CloudProvider = {
  cloud: "azure",
  launchCheckIds: AZURE_LAUNCH_CHECK_IDS,
  harvestAssessedCheckIds: AZURE_HARVEST_ASSESSED_CHECK_IDS,
  requiredRoles: REQUIRED_AZURE_ROLES,
  optionalRoles: OPTIONAL_AZURE_ROLES,
  scopeOf: subscriptionOf,
  harvester: (clock) => {
    const manifest = docAzureGroundTruth as GroundTruthManifest;
    return fixtureHarvester(inventoryFromManifest(manifest), factsFromManifest(manifest), clock);
  },
  checks: [
    checkAllResources,
    checkNoOwnerTag,
    checkUnattachedDisks,
    checkOldSnapshots,
    checkUnassociatedIps,
    checkStoppedVms,
    checkEmptyPlans,
    checkIdleLoadBalancers,
    checkIdleNatGateways,
    checkProdVmBackup,
    checkProdSqlBackup,
    checkDbZoneOrGeo,
    checkRetiringSkus,
    checkExpiringAppCerts,
    checkExpiringGatewayCerts,
  ],
  collectHarvests: collectAzureHarvests,
};
