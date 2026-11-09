import type { Cloud, Finding, Inventory } from "@farside/scan-contracts";
import type { BudgetClient } from "../budgets.js";
import type { CheckDefinition } from "../checks/define.js";
import type { Clock } from "../clock.js";
import type { CommitmentClient } from "../commitments.js";
import type { CostQueryClient } from "../cost.js";
import type { CoverageEntry } from "../coverage.js";
import type { ResourceFacts } from "../facts.js";
import type { OrgSettings } from "../settings.js";
import type { OrgRepository } from "../repository.js";

export type HarvestResult = {
  inventory: Inventory;
  coverage: CoverageEntry[];
  coveredScopes: string[];
  facts: ResourceFacts[];
};

export type Harvester = {
  harvest: (input: {
    orgId: string;
    subscriptionId: string;
    settings: OrgSettings;
  }) => Promise<HarvestResult>;
};

export type ScanHarvestClients = {
  costClient?: CostQueryClient;
  commitmentClient?: CommitmentClient;
  budgetClient?: BudgetClient;
};

/** Per-scan clients, for live clients whose token depends on the connection's tenant. */
export type HarvestClientSource = (input: { orgId: string; subscriptionId: string }) => Promise<ScanHarvestClients>;

export type PostHarvestContext = {
  orgId: string;
  subscriptionId: string;
  signal: AbortSignal;
  remainingMs: () => number;
  clock: Clock;
  clients: ScanHarvestClients;
  store: OrgRepository;
};

export type ScanOutputs = { findings: Finding[]; coverage: CoverageEntry[] };

export type PostHarvest = { persist: () => Promise<void>; apply: (outputs: ScanOutputs) => ScanOutputs };

export type CloudProvider = {
  cloud: Cloud;
  launchCheckIds: readonly string[];
  harvestAssessedCheckIds: ReadonlySet<string>;
  requiredRoles: readonly string[];
  optionalRoles: readonly string[];
  scopeOf: (resourceUri: string) => string;
  harvester: (clock?: Clock) => Harvester;
  checks: readonly CheckDefinition[];
  collectHarvests?: (context: PostHarvestContext) => Promise<PostHarvest | null>;
};
