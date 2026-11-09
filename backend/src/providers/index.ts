import { azureProvider } from "./azure.js";
import { gcpProvider } from "./gcp.js";
import { registerProvider } from "./registry.js";

registerProvider(azureProvider);
registerProvider(gcpProvider);

export {
  DEFAULT_CLOUD,
  UnknownCloudError,
  allProviders,
  findCheck,
  providerFor,
  registerProvider,
  registeredCheckIds,
} from "./registry.js";
export type {
  CloudProvider,
  HarvestClientSource,
  HarvestResult,
  Harvester,
  PostHarvest,
  ScanHarvestClients,
} from "./types.js";
