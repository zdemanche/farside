export const CONTRACT_VERSION = "farside-scan-contracts@0.1.0";

export {
  CLOUDS,
  FINDING_RESULTS,
  RAW_PROVIDER_KEYS,
  type CheckSpec,
  type Cloud,
  type Coverage,
  type CoverageScope,
  type Evidence,
  type Finding,
  type FindingResult,
  type FindingScope,
  type Inventory,
  type InventoryRecord,
  type SavingsRange,
} from "./types.js";

export {
  assertValid,
  validateCoverage,
  validateFinding,
  validateInventory,
  type ValidationError,
} from "./validate.js";

export { HEALTH_SCORE_FORMULA, scoreHealth, type HealthScore } from "./score.js";
