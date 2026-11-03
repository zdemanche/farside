import {
  checkGcpOldSnapshotsAndImages,
  checkGcpUnattachedDisks,
  checkGcpUnusedIps,
} from "../gcp-checks.js";
import {
  factsFromGcpManifest,
  inventoryFromGcpManifest,
  type GcpGroundTruthManifest,
} from "../gcp-inventory.js";
import { checkGcpSqlGkeSupport } from "../gcp-support.js";
import docGcpGroundTruth from "../../../docs/gcp/ground-truth.json" with { type: "json" };
import { fixtureHarvester } from "./fixture-harvester.js";
import { projectOf } from "./gcp-scope.js";
import { GCP_HARVEST_ASSESSED_CHECK_IDS, GCP_LAUNCH_CHECK_IDS } from "./launch-ids.js";
import type { CloudProvider } from "./types.js";

export const gcpProvider: CloudProvider = {
  cloud: "gcp",
  launchCheckIds: GCP_LAUNCH_CHECK_IDS,
  harvestAssessedCheckIds: GCP_HARVEST_ASSESSED_CHECK_IDS,
  requiredRoles: [],
  optionalRoles: [],
  scopeOf: projectOf,
  harvester: (clock) => {
    const manifest = docGcpGroundTruth as GcpGroundTruthManifest;
    return fixtureHarvester(inventoryFromGcpManifest(manifest), factsFromGcpManifest(manifest), clock);
  },
  checks: [checkGcpUnattachedDisks, checkGcpUnusedIps, checkGcpOldSnapshotsAndImages, checkGcpSqlGkeSupport],
};
