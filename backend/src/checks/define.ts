import {
  assertValid,
  validateFinding,
  type Cloud,
  type Finding,
  type FindingResult,
  type Inventory,
  type InventoryRecord,
} from "@farside/scan-contracts";
import type { ResourceFacts } from "../facts.js";
import { subscriptionOf } from "../providers/arm.js";
import { projectOf } from "../providers/gcp-scope.js";
import type { NamedSavingsRange } from "../savings.js";
import { DEFAULT_SETTINGS, type OrgSettings } from "../settings.js";

export type Fields = ResourceFacts["fields"] | undefined;
export type FactsIndex = ReadonlyMap<string, ResourceFacts>;
type FieldValue = string | number | boolean | null;

export type CheckFn = (
  inventory: Inventory,
  facts: ResourceFacts[],
  settings?: OrgSettings,
  rows?: FactsIndex,
) => Finding[];
export type CheckDefinition = CheckFn & { readonly checkId: string; readonly cloud: Cloud };

export type Verdict = {
  result: FindingResult;
  closer?: string;
  evidence: Record<string, FieldValue>;
  savings?: NamedSavingsRange;
};

export function acceptFinding(finding: Finding): Finding {
  assertValid(validateFinding(finding));
  return finding;
}

export function indexFacts(facts: readonly ResourceFacts[]): FactsIndex {
  return new Map(facts.map((row) => [row.resourceUri, row]));
}

export function str(fields: Fields, key: string): string | null {
  const value = fields?.[key];
  return typeof value === "string" ? value : null;
}

export function nonEmptyStr(fields: Fields, key: string): string | null {
  const value = str(fields, key);
  return value !== null && value.length > 0 ? value : null;
}

export function num(fields: Fields, key: string): number | null {
  const value = fields?.[key];
  return typeof value === "number" ? value : null;
}

export function bool(fields: Fields, key: string): boolean | null {
  const value = fields?.[key];
  return typeof value === "boolean" ? value : null;
}

export function pass(evidence: Verdict["evidence"]): Verdict {
  return { result: "pass", evidence };
}

export function fail(evidence: Verdict["evidence"], savings?: NamedSavingsRange): Verdict {
  return savings ? { result: "fail", evidence, savings } : { result: "fail", evidence };
}

export function undetermined(closer: string, evidence: Verdict["evidence"]): Verdict {
  return { result: "undetermined", closer, evidence };
}

export function buildFinding(
  meta: { checkId: string; cloud: Cloud },
  scopeName: string,
  { result, closer, evidence, savings }: Verdict,
): Finding {
  return acceptFinding({
    checkId: meta.checkId,
    result,
    ...(closer ? { closer } : {}),
    evidence: { fields: savings ? { ...evidence, savingsBasis: savings.basis } : evidence },
    scope: { id: `${scopeName}:${meta.checkId}`, cloud: meta.cloud, subscriptionOrProject: scopeName },
    ...(savings ? { savings: { min: savings.min, max: savings.max, currency: savings.currency } } : {}),
  });
}

export function checkDefinition(
  meta: { checkId: string; cloud: Cloud },
  run: (inventory: Inventory, facts: ResourceFacts[], settings: OrgSettings, rows: FactsIndex) => Finding[],
): CheckDefinition {
  const check: CheckFn = (inventory, facts, settings = DEFAULT_SETTINGS, rows = indexFacts(facts)) =>
    run(inventory, facts, settings, rows);
  return Object.assign(check, { checkId: meta.checkId, cloud: meta.cloud });
}

export type SelectContext = {
  rows: FactsIndex;
  settings: OrgSettings;
  scopeOf: (resourceUri: string) => string;
};

export type CheckSpec<Facts, Shared = undefined> = {
  checkId: string;
  cloud: Cloud;
  scopeOf: (resourceUri: string) => string;
  resourceType?: string | readonly string[];
  select?: (resources: InventoryRecord[], context: SelectContext) => InventoryRecord[];
  prepare?: (selected: InventoryRecord[], context: SelectContext) => Shared;
  readFacts: (resource: InventoryRecord, fields: Fields, settings: OrgSettings) => Facts;
  decide: (
    facts: Facts,
    context: { resource: InventoryRecord; settings: OrgSettings; shared: Shared },
  ) => Verdict | null;
};

export function defineCheck<Facts, Shared = undefined>(spec: CheckSpec<Facts, Shared>): CheckDefinition {
  const types =
    spec.resourceType === undefined
      ? null
      : new Set(typeof spec.resourceType === "string" ? [spec.resourceType] : spec.resourceType);
  return checkDefinition(spec, (inventory, _facts, settings, rows) => {
    const context = { rows, settings, scopeOf: spec.scopeOf };
    const typed = types
      ? inventory.resources.filter((resource) => types.has(resource.resourceType))
      : inventory.resources;
    const selected = spec.select ? spec.select(typed, context) : typed;
    const shared = spec.prepare ? spec.prepare(selected, context) : (undefined as Shared);
    return selected.flatMap((resource) => {
      const facts = spec.readFacts(resource, rows.get(resource.resourceUri)?.fields, settings);
      const verdict = spec.decide(facts, { resource, settings, shared });
      return verdict ? [buildFinding(spec, spec.scopeOf(resource.resourceUri), verdict)] : [];
    });
  });
}

type CloudCheckSpec<Facts, Shared> = Omit<CheckSpec<Facts, Shared>, "cloud" | "scopeOf">;

export function defineAzureCheck<Facts, Shared = undefined>(
  spec: CloudCheckSpec<Facts, Shared>,
): CheckDefinition {
  return defineCheck<Facts, Shared>({ ...spec, cloud: "azure", scopeOf: subscriptionOf });
}

export function defineGcpCheck<Facts, Shared = undefined>(
  spec: CloudCheckSpec<Facts, Shared>,
): CheckDefinition {
  return defineCheck<Facts, Shared>({ ...spec, cloud: "gcp", scopeOf: projectOf });
}
