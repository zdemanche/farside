import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// backend/src/cli.ts
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
import { pathToFileURL } from "node:url";

// contracts/src/types.ts
var CLOUDS = ["azure", "gcp"];
var FINDING_RESULTS = ["pass", "fail", "undetermined"];
var RAW_PROVIDER_KEYS = [
  "raw",
  "payload",
  "providerPayload",
  "sdkResponse",
  "armBody",
  "originalResponse",
  "gcpResource"
];

// contracts/src/validate.ts
var RAW_KEY_SET = new Set(RAW_PROVIDER_KEYS);
function walkForbidden(value, path, errors) {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForbidden(item, `${path}[${index}]`, errors));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (RAW_KEY_SET.has(key)) {
      errors.push({
        path: childPath,
        message: "raw provider payload fields are rejected; store aggregates only"
      });
    }
    walkForbidden(child, childPath, errors);
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decimalString(value) {
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value);
}
function validateFinding(input) {
  const errors = [];
  walkForbidden(input, "", errors);
  if (!isRecord(input)) {
    return [{ path: "", message: "finding must be an object" }, ...errors];
  }
  if (typeof input.checkId !== "string" || input.checkId.length === 0) {
    errors.push({ path: "checkId", message: "required string" });
  }
  if (!FINDING_RESULTS.includes(input.result)) {
    errors.push({ path: "result", message: "must be pass, fail, or undetermined" });
  }
  if (!isRecord(input.scope)) {
    errors.push({ path: "scope", message: "required object" });
  } else {
    if (typeof input.scope.id !== "string" || input.scope.id.length === 0) {
      errors.push({ path: "scope.id", message: "required string" });
    }
    if (!CLOUDS.includes(input.scope.cloud)) {
      errors.push({ path: "scope.cloud", message: "must be azure or gcp" });
    }
    if (typeof input.scope.subscriptionOrProject !== "string" || input.scope.subscriptionOrProject.length === 0) {
      errors.push({ path: "scope.subscriptionOrProject", message: "required string" });
    }
  }
  if (!isRecord(input.evidence) || !isRecord(input.evidence.fields)) {
    errors.push({ path: "evidence.fields", message: "finding without evidence fails validation" });
  } else if (Object.keys(input.evidence.fields).length === 0) {
    errors.push({ path: "evidence.fields", message: "finding without evidence fails validation" });
  }
  if (input.result === "undetermined") {
    if (typeof input.closer !== "string" || input.closer.trim().length === 0) {
      errors.push({
        path: "closer",
        message: "undetermined results must say what would close them"
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "savings")) {
    if (typeof input.savings === "number") {
      errors.push({ path: "savings", message: "single point value is rejected; use a min/max range" });
    } else if (!isRecord(input.savings)) {
      errors.push({ path: "savings", message: "savings must be a { min, max, currency } range" });
    } else if (Object.prototype.hasOwnProperty.call(input.savings, "amount")) {
      errors.push({ path: "savings.amount", message: "single point value is rejected; use a min/max range" });
    } else if (!decimalString(input.savings.min) || !decimalString(input.savings.max)) {
      errors.push({ path: "savings", message: "min and max must be decimal strings" });
    } else if (Number(input.savings.min) > Number(input.savings.max)) {
      errors.push({ path: "savings", message: "min must be <= max" });
    } else if (typeof input.savings.currency !== "string" || input.savings.currency.length === 0) {
      errors.push({ path: "savings.currency", message: "required string" });
    }
  }
  return errors;
}
function validateInventory(input) {
  const errors = [];
  walkForbidden(input, "", errors);
  if (!isRecord(input)) {
    return [{ path: "", message: "inventory must be an object" }, ...errors];
  }
  if (!CLOUDS.includes(input.cloud)) {
    errors.push({ path: "cloud", message: "must be azure or gcp" });
  }
  if (typeof input.observedAt !== "string" || input.observedAt.length === 0) {
    errors.push({ path: "observedAt", message: "required string" });
  }
  if (!Array.isArray(input.resources)) {
    errors.push({ path: "resources", message: "required array" });
    return errors;
  }
  input.resources.forEach((resource, index) => {
    if (!isRecord(resource)) {
      errors.push({ path: `resources[${index}]`, message: "must be an object" });
      return;
    }
    for (const field of ["resourceUri", "resourceType", "region", "displayName"]) {
      if (typeof resource[field] !== "string" || resource[field].length === 0) {
        errors.push({ path: `resources[${index}].${field}`, message: "required string" });
      }
    }
    if (!isRecord(resource.tags)) {
      errors.push({ path: `resources[${index}].tags`, message: "required object of strings" });
    }
  });
  return errors;
}
function assertValid(errors) {
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `${error.path}: ${error.message}`).join("; "));
  }
}

// backend/src/providers/arm.ts
function subscriptionOf(resourceUri) {
  return resourceUri.split("/")[2] ?? "";
}

// backend/src/providers/gcp-scope.ts
function projectOf(resourceUri) {
  const parts = resourceUri.split("/");
  const index = parts.indexOf("projects");
  const project = index >= 0 ? parts[index + 1] : void 0;
  return typeof project === "string" ? project : "";
}

// backend/src/settings.ts
var DEFAULT_SETTINGS = {
  ownerTagKey: "owner",
  productionTagKey: "environment",
  productionTagValue: "prod",
  snapshotRetentionDays: 30,
  certExpiryFlagDays: 60,
  scanScheduleEnabled: true,
  scanIntervalHours: 24,
  scanRetryLimit: 3,
  alertRecipients: [],
  updatedAt: "1970-01-01T00:00:00.000Z"
};

// backend/src/checks/define.ts
function acceptFinding(finding) {
  assertValid(validateFinding(finding));
  return finding;
}
function indexFacts(facts) {
  return new Map(facts.map((row) => [row.resourceUri, row]));
}
function str(fields, key) {
  const value = fields?.[key];
  return typeof value === "string" ? value : null;
}
function nonEmptyStr(fields, key) {
  const value = str(fields, key);
  return value !== null && value.length > 0 ? value : null;
}
function num(fields, key) {
  const value = fields?.[key];
  return typeof value === "number" ? value : null;
}
function bool(fields, key) {
  const value = fields?.[key];
  return typeof value === "boolean" ? value : null;
}
function pass(evidence) {
  return { result: "pass", evidence };
}
function fail(evidence, savings) {
  return savings ? { result: "fail", evidence, savings } : { result: "fail", evidence };
}
function undetermined(closer, evidence) {
  return { result: "undetermined", closer, evidence };
}
function buildFinding(meta, scopeName, { result, closer, evidence, savings }) {
  return acceptFinding({
    checkId: meta.checkId,
    result,
    ...closer ? { closer } : {},
    evidence: { fields: savings ? { ...evidence, savingsBasis: savings.basis } : evidence },
    scope: { id: `${scopeName}:${meta.checkId}`, cloud: meta.cloud, subscriptionOrProject: scopeName },
    ...savings ? { savings: { min: savings.min, max: savings.max, currency: savings.currency } } : {}
  });
}
function checkDefinition(meta, run) {
  const check = (inventory, facts, settings = DEFAULT_SETTINGS, rows = indexFacts(facts)) => run(inventory, facts, settings, rows);
  return Object.assign(check, { checkId: meta.checkId, cloud: meta.cloud });
}
function defineCheck(spec) {
  const types = spec.resourceType === void 0 ? null : new Set(typeof spec.resourceType === "string" ? [spec.resourceType] : spec.resourceType);
  return checkDefinition(spec, (inventory, _facts, settings, rows) => {
    const context = { rows, settings, scopeOf: spec.scopeOf };
    const typed = types ? inventory.resources.filter((resource) => types.has(resource.resourceType)) : inventory.resources;
    const selected = spec.select ? spec.select(typed, context) : typed;
    const shared = spec.prepare ? spec.prepare(selected, context) : void 0;
    return selected.flatMap((resource) => {
      const facts = spec.readFacts(resource, rows.get(resource.resourceUri)?.fields, settings);
      const verdict = spec.decide(facts, { resource, settings, shared });
      return verdict ? [buildFinding(spec, spec.scopeOf(resource.resourceUri), verdict)] : [];
    });
  });
}
function defineAzureCheck(spec) {
  return defineCheck({ ...spec, cloud: "azure", scopeOf: subscriptionOf });
}
function defineGcpCheck(spec) {
  return defineCheck({ ...spec, cloud: "gcp", scopeOf: projectOf });
}

// backend/src/causes.ts
var COVERAGE_CAUSES = {
  missing_role: {
    reason: "Farside is missing a required Azure role on this subscription, so this check did not finish.",
    closer: "Grant the missing read-only role listed on Connect, then run a scan."
  },
  throttling: {
    reason: "Azure throttled the API call for this check, so Farside stopped short of a result.",
    closer: "Wait and run the scan again. The next unattended run will retry."
  },
  unsupported_type: {
    reason: "This resource type is not on the current Farside support matrix.",
    closer: "A dated live run that marks the check verified in the Azure spec."
  },
  failed_call: {
    reason: "The Azure call for this check failed before Farside could collect evidence.",
    closer: "A successful API response for this check on the subscription."
  },
  not_run: {
    reason: "This check has not run on this subscription yet.",
    closer: "Run a scan after connect, or wait for the unattended scan."
  }
};

// backend/src/providers/registry.ts
var DEFAULT_CLOUD = "azure";
var providers = /* @__PURE__ */ new Map();
var UnknownCloudError = class extends Error {
  constructor(cloud) {
    super(`no provider is registered for cloud '${cloud}'`);
    this.name = "UnknownCloudError";
  }
};
function registerProvider(provider) {
  providers.set(provider.cloud, provider);
}
function providerFor(cloud) {
  const provider = providers.get(cloud);
  if (!provider) {
    throw new UnknownCloudError(cloud);
  }
  return provider;
}
function allProviders() {
  return [...providers.values()];
}
function findCheck(checkId) {
  for (const provider of providers.values()) {
    const check = provider.checks.find((candidate) => candidate.checkId === checkId);
    if (check) {
      return check;
    }
  }
  return void 0;
}
function registeredCheckIds(cloud) {
  return providerFor(cloud).checks.map((check) => check.checkId);
}

// backend/src/cloud.ts
function cloudFromCheckId(checkId) {
  return CLOUDS.find((cloud) => checkId.startsWith(`${cloud}-`)) ?? DEFAULT_CLOUD;
}
function matchesCloud(cloud, filter) {
  return filter == null || cloud === filter;
}

// backend/src/coverage.ts
function scopeId(subscriptionOrProject, checkId) {
  return `${subscriptionOrProject}:${checkId}`;
}
function recordCoverageScope(input) {
  const cause = input.causeId ? COVERAGE_CAUSES[input.causeId] : void 0;
  const entry = {
    id: scopeId(input.subscriptionOrProject, input.checkId),
    checkId: input.checkId,
    cloud: cloudFromCheckId(input.checkId),
    subscriptionOrProject: input.subscriptionOrProject,
    state: input.state
  };
  if (input.causeId) {
    entry.causeId = input.causeId;
  }
  if (cause?.reason) {
    entry.reason = cause.reason;
  }
  const closer = input.closer ?? cause?.closer;
  if (closer) {
    entry.closer = closer;
  }
  return entry;
}
function coverageFromHarvest(subscriptions, checkIds, assessedCheckIds) {
  const entries = [];
  for (const subscriptionOrProject of subscriptions) {
    for (const checkId of checkIds) {
      if (assessedCheckIds.has(checkId)) {
        entries.push(
          recordCoverageScope({
            subscriptionOrProject,
            checkId,
            state: "assessed"
          })
        );
      } else {
        entries.push(
          recordCoverageScope({
            subscriptionOrProject,
            checkId,
            state: "unassessed",
            causeId: "not_run"
          })
        );
      }
    }
  }
  return entries;
}
function applyCoverageResults(entries, results) {
  const incoming = /* @__PURE__ */ new Map();
  for (const result of results) {
    const next = recordCoverageScope(result);
    incoming.delete(next.id);
    incoming.set(next.id, next);
  }
  return [...entries.filter((entry) => !incoming.has(entry.id)), ...incoming.values()];
}
function applyCoverageResult(entries, result) {
  return applyCoverageResults(entries, [result]);
}
function blindSpots(entries) {
  return entries.flatMap((entry) => {
    if (entry.state === "assessed") {
      return [];
    }
    return [
      {
        id: entry.id,
        checkId: entry.checkId,
        state: entry.state,
        reason: entry.reason ?? "Farside could not check this scope.",
        closer: entry.closer ?? "A successful scan of this check on the subscription."
      }
    ];
  });
}

// backend/src/providers/unconfigured.ts
var PROVIDER_NOT_CONFIGURED = "No cloud provider is configured";
var ProviderNotConfiguredError = class extends Error {
  constructor() {
    super(PROVIDER_NOT_CONFIGURED);
    this.name = "ProviderNotConfiguredError";
  }
};
function rejectUnconfigured() {
  throw new ProviderNotConfiguredError();
}

// docs/azure/ground-truth.json
var ground_truth_default = {
  version: 1,
  story: "E1-S5",
  ownerTagKey: "owner",
  productionTagKey: "environment",
  productionTagValue: "prod",
  snapshotRetentionDays: 30,
  certExpiryFlagDays: 60,
  tenantRule: "Main and empty subscriptions must sit in a Moonaan-owned tenant that is not the Farside app-registration tenant. No customer data.",
  provisioned: false,
  provisionedNote: "Physical subscriptions, budgets, and ARM apply are E1-S5-T1/T2/T4 leftovers. This file is the repeatable seed + ground truth. Recreate from this file; do not hand-edit a live estate.",
  subscriptions: [
    {
      id: "main",
      role: "seeded-waste",
      budget: { present: true, alert: true, name: "farside-test-guard" },
      empty: false
    },
    {
      id: "empty-no-budget",
      role: "budget-positive",
      budget: { present: false },
      empty: true
    }
  ],
  items: [
    {
      id: "disk-unattached",
      subscription: "main",
      type: "Microsoft.Compute/disks",
      title: "Unattached managed disk",
      properties: { diskState: "Unattached", sizeGb: 128 },
      tags: {}
    },
    {
      id: "disk-attached",
      subscription: "main",
      type: "Microsoft.Compute/disks",
      title: "Disk attached to the deallocated VM",
      properties: { diskState: "Attached", attachedTo: "vm-deallocated" },
      tags: { owner: "farside-test" }
    },
    {
      id: "pip-unassociated",
      subscription: "main",
      type: "Microsoft.Network/publicIPAddresses",
      title: "Public IP with no ipConfiguration",
      properties: { associatedTo: null },
      tags: { owner: "farside-test" }
    },
    {
      id: "pip-associated",
      subscription: "main",
      type: "Microsoft.Network/publicIPAddresses",
      title: "Public IP on the deallocated VM NIC",
      properties: { associatedTo: "vm-deallocated" },
      tags: { owner: "farside-test" }
    },
    {
      id: "snapshot-old",
      subscription: "main",
      type: "Microsoft.Compute/snapshots",
      title: "Snapshot older than retention",
      properties: { ageDays: 90 },
      tags: { owner: "farside-test" }
    },
    {
      id: "snapshot-fresh",
      subscription: "main",
      type: "Microsoft.Compute/snapshots",
      title: "Snapshot inside retention (looks retained, must not flag)",
      properties: { ageDays: 5 },
      tags: { owner: "farside-test" }
    },
    {
      id: "vm-stopped-allocated",
      subscription: "main",
      type: "Microsoft.Compute/virtualMachines",
      title: "VM stopped but still allocated",
      properties: { powerState: "stopped", vmSize: "Standard_B2s" },
      tags: { owner: "farside-test" }
    },
    {
      id: "vm-deallocated",
      subscription: "main",
      type: "Microsoft.Compute/virtualMachines",
      title: "Deallocated VM (looks stopped; must not flag stopped-not-deallocated)",
      properties: { powerState: "deallocated", vmSize: "Standard_B2s" },
      tags: { owner: "farside-test" }
    },
    {
      id: "plan-empty",
      subscription: "main",
      type: "Microsoft.Web/serverfarms",
      title: "App Service plan with no sites",
      properties: { numberOfSites: 0, skuName: "S1" },
      tags: { owner: "farside-test" }
    },
    {
      id: "plan-with-site",
      subscription: "main",
      type: "Microsoft.Web/serverfarms",
      title: "App Service plan with one site",
      properties: { numberOfSites: 1, skuName: "S1" },
      tags: { owner: "farside-test" }
    },
    {
      id: "lb-idle",
      subscription: "main",
      type: "Microsoft.Network/loadBalancers",
      title: "Load balancer with no backend addresses",
      properties: { backendAddressCount: 0, skuName: "Standard", metricWindow: "7d", byteCount: 0 },
      tags: { owner: "farside-test" }
    },
    {
      id: "lb-busy",
      subscription: "main",
      type: "Microsoft.Network/loadBalancers",
      title: "Load balancer with backends",
      properties: { backendAddressCount: 2, skuName: "Standard", metricWindow: "7d", byteCount: 1e3 },
      tags: { owner: "farside-test" }
    },
    {
      id: "nat-idle",
      subscription: "main",
      type: "Microsoft.Network/natGateways",
      title: "NAT gateway with no subnets",
      properties: { attachedSubnetCount: 0, skuName: "Standard", metricWindow: "7d", byteCount: 0 },
      tags: { owner: "farside-test" }
    },
    {
      id: "nat-attached",
      subscription: "main",
      type: "Microsoft.Network/natGateways",
      title: "NAT gateway attached to a subnet",
      properties: { attachedSubnetCount: 1, skuName: "Standard", metricWindow: "7d", byteCount: 1e3 },
      tags: { owner: "farside-test" }
    },
    {
      id: "vm-prod-no-backup",
      subscription: "main",
      type: "Microsoft.Compute/virtualMachines",
      title: "Production VM outside Azure Backup",
      properties: { protected: false, powerState: "running" },
      tags: { owner: "farside-test", environment: "prod" }
    },
    {
      id: "vm-retiring-sku",
      subscription: "main",
      type: "Microsoft.Compute/virtualMachines",
      title: "VM on a SKU listed in the in-repo retirement catalogue",
      properties: { powerState: "running", vmSize: "Standard_B1ls", skuName: "Standard_B1ls" },
      tags: { owner: "farside-test" }
    },
    {
      id: "vm-prod-backed-up",
      subscription: "main",
      type: "Microsoft.Compute/virtualMachines",
      title: "Production VM in Azure Backup",
      properties: { protected: true, powerState: "running", vaultId: "vault-main" },
      tags: { owner: "farside-test", environment: "prod" }
    },
    {
      id: "sql-prod-no-backup",
      subscription: "main",
      type: "Microsoft.Sql/servers/databases",
      title: "Production SQL outside Azure Backup",
      properties: { protected: false, engine: "sql" },
      tags: { owner: "farside-test", environment: "prod" }
    },
    {
      id: "sql-prod-backed-up",
      subscription: "main",
      type: "Microsoft.Sql/servers/databases",
      title: "Production SQL in Azure Backup",
      properties: { protected: true, engine: "sql", vaultId: "vault-main" },
      tags: { owner: "farside-test", environment: "prod" }
    },
    {
      id: "db-no-zone-geo",
      subscription: "main",
      type: "Microsoft.Sql/servers/databases",
      title: "Database without zone redundancy or geo-backup",
      properties: { zoneRedundant: false, backupRedundancy: "Local" },
      tags: { owner: "farside-test" }
    },
    {
      id: "db-zone-geo",
      subscription: "main",
      type: "Microsoft.Sql/servers/databases",
      title: "Database with zone redundancy",
      properties: { zoneRedundant: true, backupRedundancy: "Geo" },
      tags: { owner: "farside-test" }
    },
    {
      id: "cert-app-expiring",
      subscription: "main",
      type: "Microsoft.Web/certificates",
      title: "App Service certificate inside the expiry window",
      properties: { daysRemaining: 20, expirationDate: "2026-11-22", hostName: "app.example.test" },
      tags: { owner: "farside-test" }
    },
    {
      id: "cert-app-fresh",
      subscription: "main",
      type: "Microsoft.Web/certificates",
      title: "App Service certificate well outside the expiry window",
      properties: { daysRemaining: 400, expirationDate: "2027-12-07", hostName: "fresh.example.test" },
      tags: { owner: "farside-test" }
    },
    {
      id: "cert-gateway-expiring",
      subscription: "main",
      type: "Microsoft.Network/applicationGateways",
      title: "Gateway certificate inside the expiry window",
      properties: { daysRemaining: 20, expirationDate: "2026-11-22", certificateName: "gateway-expiring" },
      tags: { owner: "farside-test" }
    },
    {
      id: "cert-gateway-fresh",
      subscription: "main",
      type: "Microsoft.Network/applicationGateways",
      title: "Gateway certificate well outside the expiry window",
      properties: { daysRemaining: 400, expirationDate: "2027-12-07", certificateName: "gateway-fresh" },
      tags: { owner: "farside-test" }
    },
    {
      id: "budget-main",
      subscription: "main",
      type: "Microsoft.Consumption/budgets",
      title: "Cost guard on the seeded subscription",
      properties: { budgetCount: 1, budgetNames: ["farside-test-guard"] },
      tags: { owner: "farside-test" }
    }
  ],
  checks: [
    {
      checkId: "azure-inventory-all-resources",
      positives: [
        "disk-unattached",
        "disk-attached",
        "pip-unassociated",
        "vm-stopped-allocated",
        "vm-deallocated",
        "vm-prod-no-backup"
      ],
      negatives: [],
      emptySubscriptionId: "empty-no-budget",
      exception: null
    },
    {
      checkId: "azure-inventory-no-owner-tag",
      positives: ["disk-unattached"],
      negatives: ["disk-attached", "vm-deallocated"],
      exception: null
    },
    {
      checkId: "azure-waste-unattached-disks",
      positives: ["disk-unattached"],
      negatives: ["disk-attached"],
      exception: null
    },
    {
      checkId: "azure-waste-unassociated-public-ips",
      positives: ["pip-unassociated"],
      negatives: ["pip-associated"],
      exception: null
    },
    {
      checkId: "azure-waste-old-snapshots",
      positives: ["snapshot-old"],
      negatives: ["snapshot-fresh"],
      exception: null
    },
    {
      checkId: "azure-waste-stopped-not-deallocated-vms",
      positives: ["vm-stopped-allocated"],
      negatives: ["vm-deallocated"],
      exception: null
    },
    {
      checkId: "azure-waste-empty-app-service-plans",
      positives: ["plan-empty"],
      negatives: ["plan-with-site"],
      exception: null
    },
    {
      checkId: "azure-waste-idle-load-balancers",
      positives: ["lb-idle"],
      negatives: ["lb-busy"],
      exception: null
    },
    {
      checkId: "azure-waste-idle-nat-gateways",
      positives: ["nat-idle"],
      negatives: ["nat-attached"],
      exception: null
    },
    {
      checkId: "azure-cost-spend-by-service",
      positives: [],
      negatives: [],
      exception: {
        status: "unverified",
        reason: "Spend-by-service needs Cost Management history on a live subscription. Fixtures cannot invent billed months."
      }
    },
    {
      checkId: "azure-cost-month-on-month",
      positives: [],
      negatives: [],
      exception: {
        status: "unverified",
        reason: "Month-on-month needs two complete billed months at one scope. The test estate does not exist yet."
      }
    },
    {
      checkId: "azure-cost-reservation-use",
      positives: [],
      negatives: [],
      exception: {
        status: "unverified",
        reason: "The test estate will not buy reservations. Fixture none-found and missing-role are covered; a live purchase stays leftover."
      }
    },
    {
      checkId: "azure-cost-savings-plan-use",
      positives: [],
      negatives: [],
      exception: {
        status: "unverified",
        reason: "The test estate will not buy savings plans. Fixture none-found is covered; a live purchase stays leftover."
      }
    },
    {
      checkId: "azure-cost-subscriptions-without-budgets",
      positives: [],
      negatives: ["budget-main"],
      emptySubscriptionId: "empty-no-budget",
      exception: null
    },
    {
      checkId: "azure-resilience-prod-vms-outside-backup",
      positives: ["vm-prod-no-backup"],
      negatives: ["vm-prod-backed-up"],
      exception: null
    },
    {
      checkId: "azure-resilience-prod-sql-outside-backup",
      positives: ["sql-prod-no-backup"],
      negatives: ["sql-prod-backed-up"],
      exception: null
    },
    {
      checkId: "azure-resilience-db-zone-or-geo",
      positives: ["db-no-zone-geo"],
      negatives: ["db-zone-geo"],
      exception: null
    },
    {
      checkId: "azure-lifecycle-retiring-skus",
      positives: ["vm-retiring-sku"],
      negatives: ["vm-deallocated"],
      exception: null
    },
    {
      checkId: "azure-lifecycle-expiring-app-service-certs",
      positives: ["cert-app-expiring"],
      negatives: ["cert-app-fresh"],
      exception: null
    },
    {
      checkId: "azure-lifecycle-expiring-gateway-certs",
      positives: ["cert-gateway-expiring"],
      negatives: ["cert-gateway-fresh"],
      exception: null
    }
  ]
};

// backend/src/budgets.ts
var NO_BUDGETS = "azure-cost-subscriptions-without-budgets";
var BUDGET_CLOSER = "Cost Management Reader and a successful budgets list on that subscription";
var BUDGET_HARVEST_UNVERIFIED = {
  harvestStatus: "unverified",
  liveRunAt: null,
  harvestStatusReason: "Budget definitions are read from the ground-truth fixture. A live Cost Management budgets list stays leftover."
};
var MANIFEST = ground_truth_default;
function budgetsFromManifest(manifest = MANIFEST, unread = []) {
  return manifest.subscriptions.map((subscription) => {
    if (unread.includes(subscription.id)) {
      return {
        subscriptionId: subscription.id,
        budgetCount: 0,
        budgetNames: [],
        readable: false
      };
    }
    const names = subscription.budget.present && subscription.budget.name ? [subscription.budget.name] : [];
    return {
      subscriptionId: subscription.id,
      budgetCount: names.length,
      budgetNames: names,
      readable: true
    };
  });
}
function fixtureBudgetClient(definitions = budgetsFromManifest()) {
  return {
    async list() {
      return definitions;
    }
  };
}
function checkNoBudgets(definitions, lastConfirmed) {
  return definitions.map((row) => {
    const scope4 = {
      id: `${row.subscriptionId}:${NO_BUDGETS}`,
      cloud: "azure",
      subscriptionOrProject: row.subscriptionId
    };
    if (!row.readable) {
      return acceptFinding({
        checkId: NO_BUDGETS,
        result: "undetermined",
        closer: BUDGET_CLOSER,
        evidence: {
          fields: {
            subscriptionId: row.subscriptionId,
            budgetCount: null,
            budgetNames: null,
            lastConfirmed
          }
        },
        scope: scope4
      });
    }
    return acceptFinding({
      checkId: NO_BUDGETS,
      result: row.budgetCount === 0 ? "fail" : "pass",
      evidence: {
        fields: {
          subscriptionId: row.subscriptionId,
          budgetCount: row.budgetCount,
          budgetNames: row.budgetNames.join(","),
          lastConfirmed
        }
      },
      scope: scope4
    });
  });
}
async function harvestBudgets(input) {
  const lastConfirmed = input.lastConfirmed ?? "1970-01-01T00:00:00.000Z";
  const subscriptions = await input.client.list();
  const findings = checkNoBudgets(subscriptions, lastConfirmed);
  const coverage = subscriptions.map(
    (row) => recordCoverageScope({
      subscriptionOrProject: row.subscriptionId,
      checkId: NO_BUDGETS,
      state: row.readable ? "assessed" : "undetermined",
      ...row.readable ? {} : { closer: BUDGET_CLOSER }
    })
  );
  return {
    snapshot: {
      lastConfirmed,
      subscriptions,
      harvestStatus: BUDGET_HARVEST_UNVERIFIED.harvestStatus,
      liveRunAt: BUDGET_HARVEST_UNVERIFIED.liveRunAt,
      harvestStatusReason: BUDGET_HARVEST_UNVERIFIED.harvestStatusReason
    },
    findings,
    coverage
  };
}
function applyBudgetCoverage(existing, harvested) {
  return applyCoverageResults(existing, harvested);
}
function mergeBudgetFindings(existing, next, subscriptionIds) {
  const scope4 = subscriptionIds ? new Set(subscriptionIds.map((id) => id.toLowerCase())) : null;
  return [
    ...existing.filter(
      (finding) => finding.checkId !== NO_BUDGETS || scope4 !== null && !scope4.has(finding.scope.subscriptionOrProject.toLowerCase())
    ),
    ...next
  ];
}
function mergeBudgetSnapshot(existing, next) {
  if (!existing) {
    return next;
  }
  const listed = new Set(next.subscriptions.map((row) => row.subscriptionId.toLowerCase()));
  return {
    ...next,
    subscriptions: [
      ...existing.subscriptions.filter((row) => !listed.has(row.subscriptionId.toLowerCase())),
      ...next.subscriptions
    ]
  };
}

// backend/src/clock.ts
var systemClock = () => (/* @__PURE__ */ new Date()).toISOString();

// backend/src/savings.ts
var DISK_SAVINGS_BASIS = "Monthly list price of the unused disk SKU and size, as a range";
var PointSavingsError = class extends Error {
  constructor() {
    super("single point value is rejected; use a min/max range");
    this.name = "PointSavingsError";
  }
};
function savingsRange(input) {
  if (input.min === input.max) {
    throw new PointSavingsError();
  }
  if (input.basis.length === 0) {
    throw new Error("savings basis is required");
  }
  const min = input.min.toFixed(2);
  const max = input.max.toFixed(2);
  if (min === max) {
    throw new PointSavingsError();
  }
  return { min, max, currency: input.currency, basis: input.basis };
}
function diskMonthlySavings(sizeGb) {
  return savingsRange({
    min: sizeGb * 0.0625,
    max: sizeGb * 0.09375,
    currency: "USD",
    basis: DISK_SAVINGS_BASIS
  });
}
var SNAPSHOT_SAVINGS_BASIS = "Monthly list price of snapshot storage for the retained size, as a range";
var PUBLIC_IP_SAVINGS_BASIS = "Monthly list price of the unused public IP SKU, as a range";
var STOPPED_VM_SAVINGS_BASIS = "Monthly compute list price of the VM size while stopped-but-allocated, as a range";
function snapshotMonthlySavings() {
  return savingsRange({ min: 1, max: 3, currency: "USD", basis: SNAPSHOT_SAVINGS_BASIS });
}
function publicIpMonthlySavings() {
  return savingsRange({ min: 3, max: 5, currency: "USD", basis: PUBLIC_IP_SAVINGS_BASIS });
}
function stoppedVmMonthlySavings() {
  return savingsRange({ min: 30.4, max: 45.6, currency: "USD", basis: STOPPED_VM_SAVINGS_BASIS });
}
var EMPTY_PLAN_SAVINGS_BASIS = "Monthly list price of the empty plan SKU, as a range";
var IDLE_LB_SAVINGS_BASIS = "Monthly list price of the unused load balancer SKU, as a range";
var IDLE_NAT_SAVINGS_BASIS = "Monthly list price of the unused NAT gateway, as a range";
function emptyPlanMonthlySavings() {
  return savingsRange({ min: 70, max: 105, currency: "USD", basis: EMPTY_PLAN_SAVINGS_BASIS });
}
function idleLbMonthlySavings() {
  return savingsRange({ min: 18, max: 27, currency: "USD", basis: IDLE_LB_SAVINGS_BASIS });
}
function idleNatMonthlySavings() {
  return savingsRange({ min: 32, max: 48, currency: "USD", basis: IDLE_NAT_SAVINGS_BASIS });
}
var RESERVATION_SAVINGS_BASIS = "Unused committed reservation spend for the period, as a range";
var SAVINGS_PLAN_SAVINGS_BASIS = "Unused committed savings-plan spend for the period, as a range";
function unusedReservationSavings(unusedHours) {
  return savingsRange({
    min: unusedHours * 0.1,
    max: unusedHours * 0.15,
    currency: "USD",
    basis: RESERVATION_SAVINGS_BASIS
  });
}
function unusedSavingsPlanSavings(unusedAmount, currency) {
  return savingsRange({
    min: unusedAmount * 0.8,
    max: unusedAmount * 1.2,
    currency,
    basis: SAVINGS_PLAN_SAVINGS_BASIS
  });
}
var GCP_DISK_SAVINGS_BASIS = "Monthly list price of the unused disk type and size, as a range";
var GCP_IP_SAVINGS_BASIS = "Monthly list price of a reserved unused external IP, as a range";
function gcpDiskMonthlySavings(sizeGb) {
  return savingsRange({
    min: sizeGb * 0.04,
    max: sizeGb * 0.06,
    currency: "USD",
    basis: GCP_DISK_SAVINGS_BASIS
  });
}
function gcpIpMonthlySavings() {
  return savingsRange({ min: 2.5, max: 4, currency: "USD", basis: GCP_IP_SAVINGS_BASIS });
}
var GCP_SNAPSHOT_IMAGE_SAVINGS_BASIS = "Monthly storage list price of the old snapshot or image, as a range";
function gcpSnapshotImageMonthlySavings(sizeGb) {
  return savingsRange({
    min: sizeGb * 0.026,
    max: sizeGb * 0.04,
    currency: "USD",
    basis: GCP_SNAPSHOT_IMAGE_SAVINGS_BASIS
  });
}
var GCP_CUD_SAVINGS_BASIS = "Unused committed-use spend as a min/max range once utilization exists";
function unusedCudSavings(unusedAmount, currency) {
  return savingsRange({
    min: unusedAmount * 0.8,
    max: unusedAmount * 1.2,
    currency,
    basis: GCP_CUD_SAVINGS_BASIS
  });
}

// docs/azure/commitments.json
var commitments_default = {
  note: "Fake reservation and savings-plan utilization for E4-S2. Not a live Azure purchase.",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  reservations: [
    {
      reservationId: "res-low",
      skuName: "Standard_D2s_v3",
      usedHours: 200,
      reservedHours: 720,
      utilisationPercent: 27.78,
      expiryDate: "2027-01-01"
    },
    {
      reservationId: "res-used",
      skuName: "Standard_B2s",
      usedHours: 700,
      reservedHours: 720,
      utilisationPercent: 97.22,
      expiryDate: "2027-06-01"
    }
  ],
  savingsPlans: [
    {
      savingsPlanId: "sp-low",
      committedAmount: "100.00",
      usedAmount: "30.00",
      utilisationPercent: 30,
      expiryDate: "2027-01-01",
      currency: "USD"
    },
    {
      savingsPlanId: "sp-used",
      committedAmount: "80.00",
      usedAmount: "76.00",
      utilisationPercent: 95,
      expiryDate: "2027-06-01",
      currency: "USD"
    }
  ]
};

// backend/src/commitments.ts
var RESERVATION_USE = "azure-cost-reservation-use";
var SAVINGS_PLAN_USE = "azure-cost-savings-plan-use";
var RESERVATIONS_ROLE_CLOSER = "Reservations Reader on the billing account that owns the reservation";
var SAVINGS_PLAN_CLOSER = "A benefits utilisation read that includes the savings plan";
var LOW_UTILISATION_PERCENT = 80;
var COMMITMENT_HARVEST_UNVERIFIED = {
  harvestStatus: "unverified",
  liveRunAt: null,
  harvestStatusReason: "The test estate will not buy reservations or savings plans. Fixture utilization is not a live purchase."
};
var MissingReservationsRoleError = class extends Error {
  constructor() {
    super("Reservations Reader is missing");
    this.name = "MissingReservationsRoleError";
  }
};
var FIXTURE = commitments_default;
function fixtureCommitmentClient(data = FIXTURE) {
  return {
    async list() {
      return {
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        reservations: data.reservations,
        savingsPlans: data.savingsPlans
      };
    }
  };
}
function scope(subscriptionId, checkId) {
  return {
    id: `${subscriptionId}:${checkId}`,
    cloud: "azure",
    subscriptionOrProject: subscriptionId
  };
}
function checkReservations(reservations, input) {
  if (reservations.length === 0) {
    return [
      acceptFinding({
        checkId: RESERVATION_USE,
        result: "pass",
        evidence: {
          fields: {
            noneFound: true,
            reservationCount: 0,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd
          }
        },
        scope: scope(input.subscriptionId, RESERVATION_USE)
      })
    ];
  }
  return reservations.map((row) => {
    const low = row.utilisationPercent < LOW_UTILISATION_PERCENT;
    const unusedHours = Math.max(row.reservedHours - row.usedHours, 0);
    const savings = low && unusedHours > 0 ? unusedReservationSavings(unusedHours) : null;
    return acceptFinding({
      checkId: RESERVATION_USE,
      result: low ? "fail" : "pass",
      evidence: {
        fields: {
          reservationId: row.reservationId,
          skuName: row.skuName,
          usedHours: row.usedHours,
          reservedHours: row.reservedHours,
          utilisationPercent: row.utilisationPercent,
          expiryDate: row.expiryDate,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          ...savings ? { savingsBasis: savings.basis } : {}
        }
      },
      scope: scope(input.subscriptionId, RESERVATION_USE),
      ...savings ? { savings: { min: savings.min, max: savings.max, currency: savings.currency } } : {}
    });
  });
}
function checkSavingsPlans(plans, input) {
  if (plans.length === 0) {
    return [
      acceptFinding({
        checkId: SAVINGS_PLAN_USE,
        result: "pass",
        evidence: {
          fields: {
            noneFound: true,
            savingsPlanCount: 0,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd
          }
        },
        scope: scope(input.subscriptionId, SAVINGS_PLAN_USE)
      })
    ];
  }
  return plans.map((row) => {
    const low = row.utilisationPercent < LOW_UTILISATION_PERCENT;
    const unused = Math.max(Number(row.committedAmount) - Number(row.usedAmount), 0);
    const savings = low && unused > 0 ? unusedSavingsPlanSavings(unused, row.currency) : null;
    return acceptFinding({
      checkId: SAVINGS_PLAN_USE,
      result: low ? "fail" : "pass",
      evidence: {
        fields: {
          savingsPlanId: row.savingsPlanId,
          committedAmount: row.committedAmount,
          usedAmount: row.usedAmount,
          utilisationPercent: row.utilisationPercent,
          expiryDate: row.expiryDate,
          currency: row.currency,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          ...savings ? { savingsBasis: savings.basis } : {}
        }
      },
      scope: scope(input.subscriptionId, SAVINGS_PLAN_USE),
      ...savings ? { savings: { min: savings.min, max: savings.max, currency: savings.currency } } : {}
    });
  });
}
function missingRoleCoverage(subscriptionId) {
  return [RESERVATION_USE, SAVINGS_PLAN_USE].map(
    (checkId) => recordCoverageScope({
      subscriptionOrProject: subscriptionId,
      checkId,
      state: "unassessed",
      causeId: "missing_role",
      closer: checkId === RESERVATION_USE ? RESERVATIONS_ROLE_CLOSER : SAVINGS_PLAN_CLOSER
    })
  );
}
async function harvestCommitments(input) {
  try {
    const listed = await input.client.list({ billingScope: input.billingScope });
    const snapshot = {
      subscriptionId: input.subscriptionId,
      billingScope: input.billingScope,
      periodStart: listed.periodStart,
      periodEnd: listed.periodEnd,
      reservations: listed.reservations,
      savingsPlans: listed.savingsPlans,
      noneFound: {
        reservations: listed.reservations.length === 0,
        savingsPlans: listed.savingsPlans.length === 0
      },
      harvestStatus: COMMITMENT_HARVEST_UNVERIFIED.harvestStatus,
      liveRunAt: COMMITMENT_HARVEST_UNVERIFIED.liveRunAt,
      harvestStatusReason: COMMITMENT_HARVEST_UNVERIFIED.harvestStatusReason
    };
    const findings = [
      ...checkReservations(listed.reservations, {
        subscriptionId: input.subscriptionId,
        periodStart: listed.periodStart,
        periodEnd: listed.periodEnd
      }),
      ...checkSavingsPlans(listed.savingsPlans, {
        subscriptionId: input.subscriptionId,
        periodStart: listed.periodStart,
        periodEnd: listed.periodEnd
      })
    ];
    const coverage = [RESERVATION_USE, SAVINGS_PLAN_USE].map(
      (checkId) => recordCoverageScope({
        subscriptionOrProject: input.subscriptionId,
        checkId,
        state: "assessed"
      })
    );
    return { ok: true, snapshot, findings, coverage };
  } catch (error) {
    if (error instanceof MissingReservationsRoleError) {
      return { ok: false, reason: "missing_role", coverage: missingRoleCoverage(input.subscriptionId) };
    }
    throw error;
  }
}
function applyCommitmentCoverage(existing, harvested) {
  return applyCoverageResults(existing, harvested);
}
function mergeCommitmentFindings(existing, next, subscriptionId) {
  const replace = /* @__PURE__ */ new Set([RESERVATION_USE, SAVINGS_PLAN_USE]);
  const wanted = subscriptionId?.toLowerCase();
  return [
    ...existing.filter(
      (finding) => !(replace.has(finding.checkId) && (wanted === void 0 || finding.scope.subscriptionOrProject.toLowerCase() === wanted))
    ),
    ...next
  ];
}

// docs/azure/cost-query-pages.json
var cost_query_pages_default = {
  note: "Fake Azure Cost Management Query pages for E4-S1 paging tests. These are not portal-verified billed months.",
  firstPage: "page-1",
  pages: {
    "page-1": {
      rows: [
        { date: "2026-09-01", serviceName: "Virtual Machines", costAmount: "20.00", currency: "USD" },
        { date: "2026-09-01", serviceName: "Storage", costAmount: "5.00", currency: "USD" },
        { date: "2026-09-02", serviceName: "Virtual Machines", costAmount: "20.00", currency: "USD" }
      ],
      nextPage: "page-2"
    },
    "page-2": {
      rows: [
        { date: "2026-09-02", serviceName: "Storage", costAmount: "5.00", currency: "USD" },
        { date: "2026-10-01", serviceName: "Virtual Machines", costAmount: "25.00", currency: "USD" },
        { date: "2026-10-01", serviceName: "Storage", costAmount: "6.00", currency: "USD" },
        { date: "2026-10-02", serviceName: "Virtual Machines", costAmount: "25.00", currency: "USD" },
        { date: "2026-10-02", serviceName: "Storage", costAmount: "6.00", currency: "USD" }
      ],
      nextPage: "page-3"
    },
    "page-3": {
      rows: [
        { date: "2026-11-01", serviceName: "Virtual Machines", costAmount: "2.00", currency: "USD" },
        { date: "2026-11-02", serviceName: "Virtual Machines", costAmount: "2.00", currency: "USD" }
      ]
    }
  }
};

// backend/src/cost.ts
var SPEND_BY_SERVICE = "azure-cost-spend-by-service";
var MONTH_ON_MONTH = "azure-cost-month-on-month";
var COST_ROLE_CLOSER = "Cost Management Reader on the right billing scope";
var TWO_MONTHS_CLOSER = "Two complete months of Cost Management data at that scope";
var CURRENCY_CLOSER = "Cost Management rows in a single currency at that scope";
var CrossCurrencyError = class extends Error {
  constructor() {
    super("totals are never summed across currencies");
    this.name = "CrossCurrencyError";
  }
};
var MissingCostRoleError = class extends Error {
  constructor() {
    super("Cost Management Reader is missing");
    this.name = "MissingCostRoleError";
  }
};
var PAGES = cost_query_pages_default;
function fixtureCostClient(pages = PAGES) {
  return {
    async query(input) {
      const key = input.page ?? pages.firstPage;
      const page = pages.pages[key];
      if (!page) {
        return { rows: [] };
      }
      return page;
    }
  };
}
function toCents(value) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const frac2 = `${fraction}00`.slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(frac2);
  return negative ? -cents : cents;
}
function fromCents(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
function addAmounts(amounts) {
  return fromCents(amounts.reduce((sum, amount) => sum + toCents(amount), 0n));
}
function totalSameCurrency(figures, currency) {
  if (figures.some((figure2) => figure2.currency !== currency)) {
    throw new CrossCurrencyError();
  }
  return addAmounts(figures.map((figure2) => figure2.costAmount));
}
function yearMonth(date) {
  return date.slice(0, 7);
}
function mixedCurrencyCoverage(subscriptionId) {
  return [SPEND_BY_SERVICE, MONTH_ON_MONTH].map(
    (checkId) => recordCoverageScope({
      subscriptionOrProject: subscriptionId,
      checkId,
      state: "undetermined",
      closer: CURRENCY_CLOSER
    })
  );
}
function completeMonthRows(rows) {
  const dates = rows.map((row) => row.date).sort();
  const first = dates[0];
  const last = dates.at(-1);
  const leadingPartial = first && !first.endsWith("-01") ? yearMonth(first) : null;
  const trailing = last ? yearMonth(last) : null;
  return rows.filter((row) => {
    const month = yearMonth(row.date);
    return month !== leadingPartial && month !== trailing;
  });
}
function missingRoleCoverage2(subscriptionId) {
  return [SPEND_BY_SERVICE, MONTH_ON_MONTH].map(
    (checkId) => recordCoverageScope({
      subscriptionOrProject: subscriptionId,
      checkId,
      state: "unassessed",
      causeId: "missing_role",
      closer: COST_ROLE_CLOSER
    })
  );
}
async function readAllCostPages(client, billingScope) {
  const rows = [];
  let page;
  for (let safety = 0; safety < 50; safety += 1) {
    const result = await client.query(page ? { billingScope, page } : { billingScope });
    rows.push(...result.rows);
    if (!result.nextPage) {
      return rows;
    }
    page = result.nextPage;
  }
  throw new Error("cost query exceeded page limit");
}
function monthOnMonth(figures, agreementType) {
  const complete = figures.filter((figure2) => !figure2.provisional);
  const months = [...new Set(complete.map((figure2) => yearMonth(figure2.periodStart)))].sort();
  const currentMonth = months[months.length - 1];
  const previousMonth = months[months.length - 2];
  if (!currentMonth || !previousMonth) {
    return [];
  }
  const services = [...new Set(complete.map((figure2) => figure2.serviceName))].sort();
  return services.flatMap((serviceName) => {
    const current = complete.find(
      (figure2) => figure2.serviceName === serviceName && yearMonth(figure2.periodStart) === currentMonth
    );
    const previous = complete.find(
      (figure2) => figure2.serviceName === serviceName && yearMonth(figure2.periodStart) === previousMonth
    );
    if (!current || !previous) {
      return [];
    }
    if (current.currency !== previous.currency) {
      throw new CrossCurrencyError();
    }
    const delta = fromCents(toCents(current.costAmount) - toCents(previous.costAmount));
    const previousCents = toCents(previous.costAmount);
    const deltaPercent = previousCents === 0n ? "0.00" : (Number(toCents(delta)) / Number(previousCents) * 100).toFixed(2);
    return [
      {
        billingScope: current.billingScope,
        currency: current.currency,
        agreementType,
        serviceName,
        currentMonth,
        previousMonth,
        currentMonthCost: current.costAmount,
        previousMonthCost: previous.costAmount,
        deltaAmount: delta,
        deltaPercent
      }
    ];
  });
}
function figuresFromRows(rows, input) {
  if (rows.length === 0) {
    return { services: [], months: [], provisionalDate: null };
  }
  const dates = rows.map((row) => row.date).sort();
  const latest = dates[dates.length - 1] ?? null;
  const complete = completeMonthRows(rows);
  const monthKeys = [...new Set(complete.map((row) => yearMonth(row.date)))].sort();
  const latestComplete = monthKeys[monthKeys.length - 1];
  const services = [...new Set(complete.map((row) => row.serviceName))].sort();
  const serviceFigures = services.flatMap((serviceName) => {
    if (!latestComplete) {
      return [];
    }
    const monthRows = complete.filter(
      (row) => row.serviceName === serviceName && yearMonth(row.date) === latestComplete
    );
    const first = monthRows[0];
    if (!first) {
      return [];
    }
    return [
      {
        billingScope: input.billingScope,
        currency: first.currency,
        agreementType: input.agreementType,
        serviceName,
        periodStart: `${latestComplete}-01`,
        periodEnd: monthRows.map((row) => row.date).sort().at(-1) ?? `${latestComplete}-01`,
        costAmount: totalSameCurrency(monthRows, first.currency),
        provisional: false
      }
    ];
  });
  const monthFigures = monthKeys.flatMap((month) => {
    const monthRows = complete.filter((row) => yearMonth(row.date) === month);
    const first = monthRows[0];
    if (!first) {
      return [];
    }
    return [
      {
        billingScope: input.billingScope,
        currency: first.currency,
        agreementType: input.agreementType,
        serviceName: "all",
        periodStart: `${month}-01`,
        periodEnd: monthRows.map((row) => row.date).sort().at(-1) ?? `${month}-01`,
        costAmount: totalSameCurrency(monthRows, first.currency),
        provisional: false
      }
    ];
  });
  return { services: serviceFigures, months: monthFigures, provisionalDate: latest };
}
async function harvestCost(input) {
  try {
    const rows = await readAllCostPages(input.client, input.billingScope);
    const figures = figuresFromRows(rows, {
      billingScope: input.billingScope,
      agreementType: input.agreementType
    });
    const serviceMonths = monthlyServiceFigures(rows, input);
    const snapshot = {
      subscriptionId: input.subscriptionId,
      billingScope: input.billingScope,
      currency: rows[0]?.currency ?? "",
      agreementType: input.agreementType,
      periodStart: figures.months[0]?.periodStart ?? "",
      periodEnd: figures.months.at(-1)?.periodEnd ?? "",
      asOf: input.asOf ?? "1970-01-01T00:00:00.000Z",
      provisionalDate: figures.provisionalDate,
      services: figures.services,
      months: figures.months,
      serviceMonths,
      monthOnMonth: monthOnMonth(serviceMonths, input.agreementType)
    };
    const coverage = [
      recordCoverageScope({
        subscriptionOrProject: input.subscriptionId,
        checkId: SPEND_BY_SERVICE,
        state: "assessed"
      }),
      snapshot.monthOnMonth.length > 0 ? recordCoverageScope({
        subscriptionOrProject: input.subscriptionId,
        checkId: MONTH_ON_MONTH,
        state: "assessed"
      }) : recordCoverageScope({
        subscriptionOrProject: input.subscriptionId,
        checkId: MONTH_ON_MONTH,
        state: "undetermined",
        closer: TWO_MONTHS_CLOSER
      })
    ];
    return { ok: true, snapshot, coverage };
  } catch (error) {
    if (error instanceof MissingCostRoleError) {
      return { ok: false, reason: "missing_role", coverage: missingRoleCoverage2(input.subscriptionId) };
    }
    if (error instanceof CrossCurrencyError) {
      return { ok: false, reason: "mixed_currency", coverage: mixedCurrencyCoverage(input.subscriptionId) };
    }
    throw error;
  }
}
function applyCostCoverage(existing, harvested) {
  return applyCoverageResults(existing, harvested);
}
function monthlyServiceFigures(rows, input) {
  if (rows.length === 0) {
    return [];
  }
  const complete = completeMonthRows(rows);
  const keys = /* @__PURE__ */ new Map();
  for (const row of complete) {
    const key = `${yearMonth(row.date)}:${row.serviceName}`;
    const group = keys.get(key) ?? [];
    group.push(row);
    keys.set(key, group);
  }
  return [...keys.entries()].flatMap(([key, group]) => {
    const first = group[0];
    if (!first) {
      return [];
    }
    const month = key.split(":")[0] ?? yearMonth(first.date);
    return [
      {
        billingScope: input.billingScope,
        currency: first.currency,
        agreementType: input.agreementType,
        serviceName: first.serviceName,
        periodStart: `${month}-01`,
        periodEnd: group.map((row) => row.date).sort().at(-1) ?? `${month}-01`,
        costAmount: totalSameCurrency(group, first.currency),
        provisional: false
      }
    ];
  });
}

// backend/src/export.ts
var EXPORT_FORMAT = "farside-export/1";
var RAW_KEY_SET2 = new Set(RAW_PROVIDER_KEYS);
function exportIssues(orgId, issues, exportedAt) {
  return {
    format: EXPORT_FORMAT,
    kind: "issues",
    orgId,
    exportedAt,
    rows: issues.map((issue) => ({
      id: issue.id,
      checkId: issue.checkId,
      resourceId: issue.resourceId,
      scopeId: issue.scopeId,
      cloud: issue.cloud,
      subscriptionOrProject: issue.subscriptionOrProject,
      status: issue.status,
      coverage: issue.coverage,
      firstSeen: issue.firstSeen,
      lastConfirmed: issue.lastConfirmed,
      savings: issue.savings ?? null
    }))
  };
}
function exportInventory(orgId, inventory, exportedAt) {
  return {
    format: EXPORT_FORMAT,
    kind: "inventory",
    orgId,
    exportedAt,
    rows: inventory ? inventory.resources.map((resource) => ({
      cloud: inventory.cloud,
      resourceUri: resource.resourceUri,
      resourceType: resource.resourceType,
      region: resource.region,
      displayName: resource.displayName,
      ownerTag: resource.ownerTag ?? null
    })) : []
  };
}
function exportCost(orgId, cost, exportedAt) {
  const rows = [];
  if (cost) {
    for (const figure2 of [...cost.services, ...cost.months]) {
      rows.push({
        billingScope: figure2.billingScope,
        currency: figure2.currency,
        agreementType: figure2.agreementType,
        name: figure2.serviceName,
        periodStart: figure2.periodStart,
        periodEnd: figure2.periodEnd,
        amount: figure2.costAmount,
        provisional: figure2.provisional
      });
    }
  }
  return {
    format: EXPORT_FORMAT,
    kind: "cost",
    orgId,
    exportedAt,
    rows
  };
}
function exportFilename(kind) {
  return `farside-${kind}.json`;
}

// backend/src/issues.ts
var RESOURCE_KEYS = [
  "diskId",
  "snapshotId",
  "publicIpId",
  "vmId",
  "planId",
  "loadBalancerId",
  "natGatewayId",
  "sqlResourceId",
  "databaseId",
  "certificateId",
  "gatewayId",
  "reservationId",
  "savingsPlanId",
  "subscriptionId",
  "resourceId"
];
function legacyResourceIdFromFinding(finding) {
  for (const key of RESOURCE_KEYS) {
    const value = finding.evidence.fields[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return finding.scope.id;
}
function resourceIdFromFinding(finding) {
  const uri = finding.evidence.fields.resourceUri;
  return typeof uri === "string" && uri.length > 0 ? uri : legacyResourceIdFromFinding(finding);
}
function issueIdentity(checkId, resourceId, scopeId2) {
  return `${checkId}:${resourceId}:${scopeId2}`;
}
function rekeyLegacyIssues(byId, findings) {
  for (const finding of findings) {
    if (finding.result === "pass") {
      continue;
    }
    const resourceId = resourceIdFromFinding(finding);
    const id = issueIdentity(finding.checkId, resourceId, finding.scope.id);
    const legacyId = issueIdentity(finding.checkId, legacyResourceIdFromFinding(finding), finding.scope.id);
    const legacy = byId.get(legacyId);
    if (legacyId === id || !legacy || byId.has(id)) {
      continue;
    }
    byId.delete(legacyId);
    byId.set(id, { ...legacy, id, resourceId });
  }
}
function applyScanToIssues(input) {
  const limit = input.checkIds ? new Set(input.checkIds) : null;
  const byId = new Map(input.issues.map((issue) => [issue.id, { ...issue }]));
  rekeyLegacyIssues(
    byId,
    limit ? input.findings.filter((finding) => limit.has(finding.checkId)) : input.findings
  );
  const coverageById = /* @__PURE__ */ new Map();
  for (const entry of input.coverage) {
    if (!coverageById.has(entry.id)) {
      coverageById.set(entry.id, entry);
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const undetermined2 = /* @__PURE__ */ new Map();
  for (const finding of input.findings) {
    if (limit && !limit.has(finding.checkId)) {
      continue;
    }
    const resourceId = resourceIdFromFinding(finding);
    const id = issueIdentity(finding.checkId, resourceId, finding.scope.id);
    if (finding.result === "undetermined") {
      undetermined2.set(id, finding.closer);
    }
    if (finding.result !== "fail") {
      continue;
    }
    seen.add(id);
    const current = byId.get(id);
    const next = {
      id,
      checkId: finding.checkId,
      resourceId,
      scopeId: finding.scope.id,
      cloud: finding.scope.cloud,
      subscriptionOrProject: finding.scope.subscriptionOrProject,
      status: "open",
      evidence: { ...finding.evidence.fields },
      coverage: "assessed",
      firstSeen: current?.firstSeen ?? input.observedAt,
      lastConfirmed: input.observedAt
    };
    if (finding.savings) {
      next.savings = finding.savings;
    }
    byId.set(id, next);
  }
  for (const issue of byId.values()) {
    if (seen.has(issue.id) || issue.status === "closed") {
      continue;
    }
    if (limit && !limit.has(issue.checkId)) {
      continue;
    }
    const coverage = coverageById.get(issue.scopeId);
    if (undetermined2.has(issue.id)) {
      issue.status = "not_confirmed";
      issue.coverage = "undetermined";
      issue.notConfirmedReason = undetermined2.get(issue.id) ?? "This scan could not determine the result for this resource.";
      delete issue.closingScanId;
    } else if (coverage?.state === "assessed") {
      issue.status = "closed";
      issue.coverage = "assessed";
      issue.closingScanId = input.scanId;
      delete issue.notConfirmedReason;
    } else {
      issue.status = "not_confirmed";
      issue.coverage = coverage?.state ?? "unassessed";
      issue.notConfirmedReason = coverage?.reason ?? "This scan did not cover the issue scope, so Farside could not confirm it.";
      delete issue.closingScanId;
    }
    byId.set(issue.id, issue);
  }
  return [...byId.values()];
}

// backend/src/waste.ts
function addDecimal(left, right) {
  return (Number(left) + Number(right)).toFixed(2);
}
function isWasteFinding(finding) {
  return /^(azure|gcp)-waste-/.test(finding.checkId) && finding.result === "fail" && finding.savings != null;
}
function isAssessedFinding(coverage, finding) {
  const id = scopeId(finding.scope.subscriptionOrProject, finding.checkId);
  return coverage.some((entry) => entry.id === id && entry.state === "assessed");
}
function wasteTotals(findings, coverage) {
  const assessed = findings.filter((finding) => isWasteFinding(finding) && isAssessedFinding(coverage, finding));
  const unassessedScopes = coverage.filter(
    (entry) => /^(azure|gcp)-waste-/.test(entry.checkId) && entry.state !== "assessed"
  ).length;
  const currency = assessed[0]?.savings?.currency ?? "USD";
  return {
    min: assessed.reduce((sum, finding) => addDecimal(sum, finding.savings?.min ?? "0.00"), "0.00"),
    max: assessed.reduce((sum, finding) => addDecimal(sum, finding.savings?.max ?? "0.00"), "0.00"),
    currency,
    assessedCount: assessed.length,
    unassessedScopes
  };
}

// docs/azure/launch-checks.json
var launch_checks_default = {
  version: 1,
  cloud: "azure",
  sharedContractNote: "Fields here are Farside-local. Dashmeta 0.11.0 was read in E1-S2 (`docs/scan-contracts.md`); this spec is not a dashmeta schema. Do not invent dashmeta field names.",
  statusRule: "An entry is unverified until a dated live run exists. Unverified entries are labelled not-supported. Live verification is E1-S7.",
  statusAsOf: "2026-11-04",
  rolesFromProposal: [
    "Reader",
    "Cost Management Reader",
    "Monitoring Reader",
    "Reservations Reader",
    "Backup Reader"
  ],
  checks: [
    {
      id: "azure-inventory-all-resources",
      group: "inventory",
      title: "All resources by subscription, type, and region",
      role: "Reader",
      dataSource: "Azure Resource Graph `Resources` table (resource id, type, location, subscriptionId)",
      evidenceFields: ["subscriptionId", "resourceId", "type", "location", "countByType"],
      savingsBasis: null,
      undetermined: [
        {
          when: "Resource Graph returns incomplete or forbidden results for a subscription",
          closer: "Grant Reader on that subscription and a successful ARG query"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-inventory-no-owner-tag",
      group: "inventory",
      title: "Resources with no owner tag",
      role: "Reader",
      dataSource: "Azure Resource Graph `Resources` tags column; owner tag name is a Settings value",
      evidenceFields: ["resourceId", "type", "tagsPresent", "ownerTagKey", "ownerTagValue"],
      savingsBasis: null,
      undetermined: [
        {
          when: "The owner tag key has not been configured for the org",
          closer: "Set the owner tag key in Settings"
        },
        {
          when: "Tags are not returned for a resource type",
          closer: "A Resource Graph row for that type that includes tags"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-waste-unattached-disks",
      group: "waste",
      title: "Unattached disks",
      role: "Reader",
      dataSource: "Azure Resource Graph / Microsoft.Compute/disks where diskState is Unattached (or managedBy is empty)",
      evidenceFields: ["diskId", "diskState", "skuName", "sizeGb", "location"],
      savingsBasis: "Monthly list price of the unused disk SKU and size, as a range",
      undetermined: [
        {
          when: "diskState or managedBy is missing on a disk row",
          closer: "A disk read that includes diskState and managedBy"
        },
        {
          when: "No price for that SKU and region is available",
          closer: "A retail or agreement price row for the SKU in that region"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-waste-unassociated-public-ips",
      group: "waste",
      title: "Unassociated public IPs",
      role: "Reader",
      dataSource: "Microsoft.Network/publicIPAddresses where ipConfiguration is empty",
      evidenceFields: ["publicIpId", "skuName", "allocationMethod", "associatedTo"],
      savingsBasis: "Monthly list price of the unused public IP SKU, as a range",
      undetermined: [
        {
          when: "Association properties are not returned",
          closer: "A public IP read that includes ipConfiguration / natGateway / associated resource"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-waste-old-snapshots",
      group: "waste",
      title: "Old snapshots",
      role: "Reader",
      dataSource: "Microsoft.Compute/snapshots with timeCreated older than the org retention threshold",
      evidenceFields: ["snapshotId", "timeCreated", "ageDays", "skuName", "sourceDiskId"],
      savingsBasis: "Monthly list price of snapshot storage for the retained size, as a range",
      undetermined: [
        {
          when: "The retention threshold is not configured",
          closer: "Set snapshot retention days in Settings"
        },
        {
          when: "timeCreated is missing",
          closer: "A snapshot read that includes timeCreated"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-waste-stopped-not-deallocated-vms",
      group: "waste",
      title: "VMs stopped but not deallocated",
      role: "Reader",
      dataSource: "Microsoft.Compute/virtualMachines instance view powerState (stopped vs deallocated)",
      evidenceFields: ["vmId", "powerState", "vmSize", "location"],
      savingsBasis: "Monthly compute list price of the VM size while stopped-but-allocated, as a range",
      undetermined: [
        {
          when: "Instance view / powerState is not available",
          closer: "A VM instance-view read that includes powerState"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-waste-empty-app-service-plans",
      group: "waste",
      title: "Empty App Service plans",
      role: "Reader",
      dataSource: "Microsoft.Web/serverfarms with numberOfSites = 0 (or no Microsoft.Web/sites on the plan)",
      evidenceFields: ["planId", "skuName", "numberOfSites", "kind"],
      savingsBasis: "Monthly list price of the empty plan SKU, as a range",
      undetermined: [
        {
          when: "numberOfSites is missing and site-to-plan links cannot be listed",
          closer: "A plan read that includes numberOfSites, or a complete sites list"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-waste-idle-load-balancers",
      group: "waste",
      title: "Idle load balancers",
      role: "Reader",
      dataSource: "Microsoft.Network/loadBalancers with no backend addresses, plus Monitoring Reader metrics if traffic is required to call it idle",
      evidenceFields: ["loadBalancerId", "skuName", "backendAddressCount", "metricWindow"],
      savingsBasis: "Monthly list price of the unused load balancer SKU, as a range",
      undetermined: [
        {
          when: "Backend pools are not returned",
          closer: "A load balancer read that includes backend address pools"
        },
        {
          when: "Idle is defined by traffic and metrics are missing",
          closer: "Monitoring Reader and a metric series for the balancer"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-waste-idle-nat-gateways",
      group: "waste",
      title: "Idle NAT gateways",
      role: "Reader",
      dataSource: "Microsoft.Network/natGateways with no attached subnets, plus Monitoring Reader metrics if traffic is required",
      evidenceFields: ["natGatewayId", "attachedSubnetCount", "skuName"],
      savingsBasis: "Monthly list price of the unused NAT gateway, as a range",
      undetermined: [
        {
          when: "Subnet associations are not returned",
          closer: "A NAT gateway read that includes subnets"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-cost-spend-by-service",
      group: "cost",
      title: "Spend by service",
      role: "Cost Management Reader",
      dataSource: "Cost Management Query API, grouped by ServiceName for the selected billing scope and currency",
      evidenceFields: ["billingScope", "currency", "periodStart", "periodEnd", "serviceName", "costAmount"],
      savingsBasis: null,
      undetermined: [
        {
          when: "The billing scope (subscription, billing account, or MCA profile) cannot be resolved",
          closer: "Cost Management Reader on the right billing scope"
        },
        {
          when: "Currency or amortised vs actual cost is not stated on the response",
          closer: "A query that returns currency and cost type"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-cost-month-on-month",
      group: "cost",
      title: "Month-on-month spend change",
      role: "Cost Management Reader",
      dataSource: "Cost Management Query API for the current and previous full months at the same billing scope and currency",
      evidenceFields: ["billingScope", "currency", "currentMonthCost", "previousMonthCost", "deltaAmount", "deltaPercent"],
      savingsBasis: null,
      undetermined: [
        {
          when: "Fewer than two complete months of cost data exist",
          closer: "Two complete months of Cost Management data at that scope"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-cost-reservation-use",
      group: "cost",
      title: "Reservation use",
      role: "Reservations Reader",
      dataSource: "Reservations Summaries / Benefits utilisation APIs (usedHours vs reservedHours, coverage)",
      evidenceFields: ["reservationId", "skuName", "usedHours", "reservedHours", "utilisationPercent", "expiryDate"],
      savingsBasis: "Unused committed reservation spend for the period, as a range",
      undetermined: [
        {
          when: "Reservations Reader is missing or the billing account is not in scope",
          closer: "Reservations Reader on the billing account that owns the reservation"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-cost-savings-plan-use",
      group: "cost",
      title: "Savings plan use",
      role: "Reservations Reader",
      dataSource: "Savings plan utilisation APIs (committed amount vs used amount)",
      evidenceFields: ["savingsPlanId", "committedAmount", "usedAmount", "utilisationPercent", "expiryDate", "currency"],
      savingsBasis: "Unused committed savings-plan spend for the period, as a range",
      undetermined: [
        {
          when: "Savings plan utilisation is not returned",
          closer: "A benefits utilisation read that includes the savings plan"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-cost-subscriptions-without-budgets",
      group: "cost",
      title: "Subscriptions without budgets",
      role: "Cost Management Reader",
      dataSource: "Cost Management budgets API listed per subscription",
      evidenceFields: ["subscriptionId", "budgetCount", "budgetNames"],
      savingsBasis: null,
      undetermined: [
        {
          when: "Budgets cannot be listed for a subscription",
          closer: "Cost Management Reader and a successful budgets list on that subscription"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-resilience-prod-vms-outside-backup",
      group: "resilience",
      title: "Production VMs outside Azure Backup",
      role: "Backup Reader",
      dataSource: "Recovery Services vault backup items (VM) compared to VMs tagged or marked production in Settings",
      evidenceFields: ["vmId", "productionMarker", "vaultId", "protected"],
      savingsBasis: null,
      undetermined: [
        {
          when: "The production marker is not configured",
          closer: "Set the production tag or name pattern in Settings"
        },
        {
          when: "Vault items cannot be listed",
          closer: "Backup Reader on the vaults in scope"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-resilience-prod-sql-outside-backup",
      group: "resilience",
      title: "Production SQL outside Azure Backup",
      role: "Backup Reader",
      dataSource: "Recovery Services / backup items for Azure SQL compared to production SQL servers or databases",
      evidenceFields: ["sqlResourceId", "productionMarker", "vaultId", "protected"],
      savingsBasis: null,
      undetermined: [
        {
          when: "SQL backup items cannot be listed",
          closer: "Backup Reader on the relevant vaults and a list of SQL backup items"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-resilience-db-zone-or-geo",
      group: "resilience",
      title: "Databases without zone redundancy or geo-backup",
      role: "Reader",
      dataSource: "Azure SQL / Cosmos / MySQL / PostgreSQL properties: zoneRedundant, geoRedundantBackup / backup storage redundancy",
      evidenceFields: ["databaseId", "engine", "zoneRedundant", "backupRedundancy"],
      savingsBasis: null,
      undetermined: [
        {
          when: "Zone or backup redundancy properties are not returned for an engine",
          closer: "A database read that includes those properties for that engine"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-lifecycle-retiring-skus",
      group: "lifecycle",
      title: "Retiring SKUs",
      role: "Reader",
      dataSource: "Resource SKU plus Azure retirement / service health announcements matched by SKU or resource type",
      evidenceFields: ["resourceId", "skuName", "retirementDate", "announcementId"],
      savingsBasis: null,
      undetermined: [
        {
          when: "No retirement catalogue is available for that SKU",
          closer: "A dated retirement announcement or SKU retirement list that includes the SKU"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-lifecycle-expiring-app-service-certs",
      group: "lifecycle",
      title: "Expiring App Service certificates",
      role: "Reader",
      dataSource: "Microsoft.Web/certificates (and custom hostname bindings) expirationDate",
      evidenceFields: ["certificateId", "hostName", "expirationDate", "daysRemaining"],
      savingsBasis: null,
      undetermined: [
        {
          when: "expirationDate is missing on a certificate or binding",
          closer: "A certificate read that includes expirationDate"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "azure-lifecycle-expiring-gateway-certs",
      group: "lifecycle",
      title: "Expiring gateway certificates",
      role: "Reader",
      dataSource: "Application Gateway / Front Door / API Management SSL certificate expiry",
      evidenceFields: ["gatewayId", "certificateName", "expirationDate", "daysRemaining"],
      savingsBasis: null,
      undetermined: [
        {
          when: "Gateway certificate expiry is not returned",
          closer: "A gateway HTTPS listener / custom domain read that includes certificate expiry"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    }
  ]
};

// docs/gcp/launch-checks.json
var launch_checks_default2 = {
  version: 1,
  cloud: "gcp",
  sharedContractNote: "Fields here are Farside-local. Same shape as docs/azure/launch-checks.json. Do not invent dashmeta or AIF field names.",
  statusRule: "An entry is unverified until a dated live run exists. Unverified entries are labelled not-supported. Live verification needs D7 and a GCP test project (E6-S1-T1).",
  rolesFromProposal: [
    "Cloud Asset Viewer",
    "Compute Viewer",
    "Recommender Viewer",
    "Cloud SQL Viewer",
    "Certificate Manager Viewer",
    "BigQuery access to the billing export"
  ],
  billingExportNote: "GCP has no cost API. Spend and committed-use checks stay unassessed until the BigQuery billing export is enabled. The export fills only from that day forward, so the first day is empty.",
  checks: [
    {
      id: "gcp-inventory-all-assets",
      group: "inventory",
      title: "All assets by project and type",
      role: "Cloud Asset Viewer",
      dataSource: "Cloud Asset Inventory search / list (name, assetType, location, project)",
      evidenceFields: ["projectId", "assetName", "assetType", "location", "countByType"],
      savingsBasis: null,
      billingExportRequired: false,
      undetermined: [
        {
          when: "Cloud Asset returns incomplete or forbidden results for a project",
          closer: "Grant Cloud Asset Viewer on that project and a successful asset list"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-inventory-no-owner-label",
      group: "inventory",
      title: "Resources with no owner label",
      role: "Cloud Asset Viewer",
      dataSource: "Cloud Asset labels; owner label key is a Settings value",
      evidenceFields: ["assetName", "assetType", "labelsPresent", "ownerLabelKey", "ownerLabelValue"],
      savingsBasis: null,
      billingExportRequired: false,
      undetermined: [
        {
          when: "The owner label key has not been configured for the org",
          closer: "Set the owner label key in Settings"
        },
        {
          when: "Labels are not returned for an asset type",
          closer: "A Cloud Asset row for that type that includes labels"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-waste-unattached-disks",
      group: "waste",
      title: "Unattached disks",
      role: "Compute Viewer",
      dataSource: "Compute Engine disks where users is empty",
      evidenceFields: ["diskId", "usersCount", "sizeGb", "zone"],
      savingsBasis: "Monthly list price of the unused disk type and size, as a range",
      billingExportRequired: false,
      undetermined: [
        {
          when: "users is missing on a disk row",
          closer: "A disk read that includes the users list"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-waste-unused-external-ips",
      group: "waste",
      title: "Reserved but unused external IPs",
      role: "Compute Viewer",
      dataSource: "Compute Engine regional/global addresses where status is RESERVED and users is empty",
      evidenceFields: ["addressId", "address", "status", "usersCount", "region"],
      savingsBasis: "Monthly list price of a reserved unused external IP, as a range",
      billingExportRequired: false,
      undetermined: [
        {
          when: "status or users is missing on an address row",
          closer: "An address read that includes status and users"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-waste-old-snapshots-and-images",
      group: "waste",
      title: "Old snapshots and images",
      role: "Compute Viewer",
      dataSource: "Compute Engine snapshots and custom images older than Settings snapshotRetentionDays",
      evidenceFields: ["snapshotOrImageId", "creationTimestamp", "ageDays", "retentionDays"],
      savingsBasis: "Monthly storage list price of the old snapshot or image, as a range",
      billingExportRequired: false,
      undetermined: [
        {
          when: "creationTimestamp is missing",
          closer: "A snapshot or image read that includes creationTimestamp"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-waste-idle-vm-and-disk-recommendations",
      group: "waste",
      title: "Idle VM and disk recommendations",
      role: "Recommender Viewer",
      dataSource: "Recommender idle VM and idle disk recommendations. Fixture harvest is seeded; live run is leftover.",
      evidenceFields: ["recommendationId", "recommenderId", "resourceName", "subtype"],
      savingsBasis: "Recommender savings range when present; otherwise undetermined, not a point value",
      billingExportRequired: false,
      undetermined: [
        {
          when: "Recommender is not granted or returns no insights window",
          closer: "Grant Recommender Viewer and a recommendation list for that project"
        },
        {
          when: "A recommendation has no savings range",
          closer: "A recommendation primaryImpact with a min/max cost range"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-cost-spend-by-service",
      group: "cost",
      title: "Spend by service and project",
      role: "BigQuery access to the billing export",
      dataSource: "BigQuery billing export. There is no GCP cost API. History starts the day the export is enabled.",
      evidenceFields: ["billingAccountId", "projectId", "serviceDescription", "costAmount", "currency", "exportDay"],
      savingsBasis: null,
      billingExportRequired: true,
      undetermined: [
        {
          when: "The billing export dataset is missing or not granted",
          closer: "Enable the BigQuery billing export and grant the Farside workload read access"
        },
        {
          when: "The export has no completed day yet",
          closer: "At least one completed export day after enablement"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-cost-committed-use",
      group: "cost",
      title: "Committed-use discount use",
      role: "BigQuery access to the billing export",
      dataSource: "BigQuery billing export credits / CUD rows. Fixture check implemented; live run unverified. Not a live purchase API.",
      evidenceFields: ["billingAccountId", "commitmentName", "utilizationPercent", "currency"],
      savingsBasis: "Unused committed-use spend as a min/max range once utilization exists",
      billingExportRequired: true,
      undetermined: [
        {
          when: "The billing export is missing",
          closer: "Enable the BigQuery billing export"
        },
        {
          when: "No CUD rows exist. None-found is not zero utilization",
          closer: "Export rows that name a committed-use discount, or an explicit none-found coverage cell"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-resilience-sql-ha-or-backup",
      group: "resilience",
      title: "Cloud SQL without high availability or backups",
      role: "Cloud SQL Viewer",
      dataSource: "Cloud SQL instances availabilityType and backupConfiguration",
      evidenceFields: ["instanceName", "availabilityType", "backupEnabled", "projectId"],
      savingsBasis: null,
      billingExportRequired: false,
      undetermined: [
        {
          when: "availabilityType or backupConfiguration is missing",
          closer: "A Cloud SQL instance read that includes both fields"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-lifecycle-sql-gke-support",
      group: "lifecycle",
      title: "Out-of-support SQL and GKE versions",
      role: "Cloud SQL Viewer",
      dataSource: "Cloud SQL databaseVersion and GKE currentMasterVersion from Cloud Asset or the SQL/GKE APIs. Support calendars are Farside-test data until a live announcement source exists.",
      evidenceFields: ["resourceName", "resourceKind", "version", "supportEnd"],
      savingsBasis: null,
      billingExportRequired: false,
      undetermined: [
        {
          when: "version is missing",
          closer: "An instance or cluster read that includes the engine version"
        },
        {
          when: "No support-end date is recorded for that version",
          closer: "A dated support calendar row for that version"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    },
    {
      id: "gcp-lifecycle-expiring-certs",
      group: "lifecycle",
      title: "Expiring certificates",
      role: "Certificate Manager Viewer",
      dataSource: "Certificate Manager certificates expireTime vs Settings certExpiryFlagDays",
      evidenceFields: ["certificateId", "expireTime", "daysRemaining", "flagDays"],
      savingsBasis: null,
      billingExportRequired: false,
      undetermined: [
        {
          when: "expireTime is missing",
          closer: "A Certificate Manager read that includes expireTime"
        }
      ],
      status: "unverified",
      support: "not-supported",
      liveRunAt: null
    }
  ]
};

// backend/src/headline.ts
var AZURE_WASTE_PREFIX = "azure-waste-";
var GCP_WASTE_PREFIX = "gcp-waste-";
var GCP_SPEND = "gcp-cost-spend-by-service";
var BACKUP_IDS = {
  azure: [
    "azure-resilience-prod-vms-outside-backup",
    "azure-resilience-prod-sql-outside-backup"
  ],
  gcp: ["gcp-resilience-sql-ha-or-backup"]
};
var LIFECYCLE_IDS = {
  azure: [
    "azure-lifecycle-retiring-skus",
    "azure-lifecycle-expiring-app-service-certs",
    "azure-lifecycle-expiring-gateway-certs"
  ],
  gcp: ["gcp-lifecycle-sql-gke-support", "gcp-lifecycle-expiring-certs"]
};
var AZURE_SPEC = launch_checks_default;
var GCP_SPEC = launch_checks_default2;
function runRecordsFromSpec(specs = [AZURE_SPEC, GCP_SPEC]) {
  return specs.flatMap(
    (spec) => spec.checks.flatMap(
      (check) => check.liveRunAt ? [{ checkId: check.id, liveRunAt: check.liveRunAt }] : []
    )
  );
}
function isProven(checkId, records) {
  return records.some((record) => record.checkId === checkId);
}
function wastePrefix(cloud) {
  return cloud === "gcp" ? GCP_WASTE_PREFIX : AZURE_WASTE_PREFIX;
}
function spendCheckId(cloud) {
  return cloud === "gcp" ? GCP_SPEND : SPEND_BY_SERVICE;
}
function figure(id, label, href, status, value) {
  return { id, label, href, status, value: status === "ok" ? value : null };
}
function latestMonthCost(cost) {
  const last = cost?.months.at(-1);
  return last?.costAmount ?? null;
}
var RESOURCE_ID_FIELDS = ["vmId", "sqlResourceId", "instanceName", "resourceName"];
var LIFECYCLE_DATE_FIELDS = ["retirementDate", "expirationDate", "supportEnd", "expireTime"];
var LIFECYCLE_WINDOW_DAYS = 90;
var DAY_MS = 864e5;
function resourceKey(finding) {
  const field = RESOURCE_ID_FIELDS.find((name) => typeof finding.evidence.fields[name] === "string");
  const id = field ? String(finding.evidence.fields[field]) : finding.scope.id;
  return `${finding.checkId}:${finding.scope.subscriptionOrProject}:${id}`;
}
function backupCounts(findings, coverage, records, cloud) {
  const proven = findings.filter(
    (finding) => BACKUP_IDS[cloud].includes(finding.checkId) && isProven(finding.checkId, records)
  );
  const assessed = proven.filter((finding) => isAssessedFinding(coverage, finding));
  const keysWhere = (list, predicate) => new Set(list.filter(predicate).map(resourceKey));
  return {
    unprotected: keysWhere(assessed, (finding) => finding.result === "fail").size,
    production: keysWhere(assessed, (finding) => finding.result !== "undetermined").size,
    undetermined: keysWhere(proven, (finding) => finding.result === "undetermined").size
  };
}
function withinLifecycleWindow(finding, now) {
  const field = LIFECYCLE_DATE_FIELDS.find((name) => typeof finding.evidence.fields[name] === "string");
  if (!field) {
    return false;
  }
  const date = Date.parse(String(finding.evidence.fields[field]).slice(0, 10));
  const today = Date.parse(now.slice(0, 10));
  return Number.isFinite(date) && Number.isFinite(today) && date - today <= LIFECYCLE_WINDOW_DAYS * DAY_MS;
}
function lifecycleCount(findings, coverage, records, cloud, now) {
  return findings.filter(
    (finding) => LIFECYCLE_IDS[cloud].includes(finding.checkId) && isProven(finding.checkId, records) && isAssessedFinding(coverage, finding) && finding.result === "fail" && withinLifecycleWindow(finding, now)
  ).length;
}
function groupStatus(checkIds, coverage, records) {
  const proven = checkIds.filter((checkId) => isProven(checkId, records));
  if (proven.length === 0) {
    return "not_supported";
  }
  const assessed = proven.some(
    (checkId) => coverage.some((entry) => entry.checkId === checkId && entry.state === "assessed")
  );
  return assessed ? "ok" : "not_assessed";
}
function costForCloud(input) {
  if (input.costs && Object.prototype.hasOwnProperty.call(input.costs, input.cloud)) {
    return input.costs[input.cloud] ?? null;
  }
  if (input.cloud === "azure") {
    return input.cost ?? null;
  }
  return null;
}
function buildCloudFigures(input) {
  const prefix = wastePrefix(input.cloud);
  const spendId = spendCheckId(input.cloud);
  const findings = input.findings.filter((finding) => matchesCloud(finding.scope.cloud, input.cloud));
  const coverage = input.coverage.filter((entry) => matchesCloud(entry.cloud, input.cloud));
  const wasteChecks = [
    ...new Set(findings.filter((finding) => finding.checkId.startsWith(prefix)).map((finding) => finding.checkId)),
    ...coverage.filter((entry) => entry.checkId.startsWith(prefix)).map((entry) => entry.checkId)
  ];
  const uniqueWaste = [...new Set(wasteChecks)];
  const provenWasteFindings = findings.filter(
    (finding) => isWasteFinding(finding) && isProven(finding.checkId, input.records)
  );
  const provenWasteCoverage = coverage.filter(
    (entry) => entry.checkId.startsWith(prefix) && isProven(entry.checkId, input.records)
  );
  const spendStatus = !isProven(spendId, input.records) ? "not_supported" : input.cost && coverage.some((entry) => entry.checkId === spendId && entry.state === "assessed") ? "ok" : "not_assessed";
  const wasteStatus = groupStatus(
    uniqueWaste.length > 0 ? uniqueWaste : [`${prefix}unattached-disks`],
    coverage,
    input.records
  );
  const backupStatus = groupStatus(BACKUP_IDS[input.cloud], coverage, input.records);
  const lifecycleStatus = groupStatus(LIFECYCLE_IDS[input.cloud], coverage, input.records);
  const unseenStatus = input.records.some((record) => record.checkId.startsWith(`${input.cloud}-`)) ? "ok" : "not_supported";
  const totals = wasteTotals(provenWasteFindings, provenWasteCoverage);
  const backup = backupCounts(findings, coverage, input.records, input.cloud);
  const losingSupport = lifecycleCount(findings, coverage, input.records, input.cloud, input.now);
  const unseen = coverage.filter(
    (entry) => isProven(entry.checkId, input.records) && entry.state !== "assessed"
  ).length;
  return [
    figure(
      "monthlyCost",
      "Monthly cost",
      "#cost-and-waste",
      spendStatus,
      spendStatus === "ok" ? { amount: latestMonthCost(input.cost), currency: input.cost?.currency ?? "USD" } : null
    ),
    figure(
      "waste",
      "Nameable waste",
      "#issues",
      wasteStatus,
      wasteStatus === "ok" ? { min: totals.min, max: totals.max, currency: totals.currency } : null
    ),
    figure(
      "backup",
      "Production systems not backed up",
      "#recovery",
      backupStatus,
      backupStatus === "ok" ? backup : null
    ),
    figure(
      "lifecycle",
      "Things losing support in 90 days",
      "#lifecycle",
      lifecycleStatus,
      lifecycleStatus === "ok" ? { count: losingSupport } : null
    ),
    figure(
      "unseen",
      "What Farside could not see",
      "#blind-spots",
      unseenStatus,
      unseenStatus === "ok" ? { count: unseen } : null
    )
  ];
}
function pickMoneyValue(figures, id) {
  const ok = figures.flatMap((cloud) => {
    const found = cloud.figures.find((figure2) => figure2.id === id);
    return found?.status === "ok" && found.value ? [{ cloud: cloud.cloud, value: found.value }] : [];
  });
  if (ok.length === 0) {
    return null;
  }
  if (ok.length === 1) {
    return ok[0]?.value ?? null;
  }
  const currencies = new Set(
    ok.map((item) => typeof item.value.currency === "string" ? item.value.currency : "").filter(Boolean)
  );
  if (currencies.size > 1) {
    return {
      byCloud: Object.fromEntries(ok.map((item) => [item.cloud, item.value])),
      mixedCurrencies: true
    };
  }
  return { byCloud: Object.fromEntries(ok.map((item) => [item.cloud, item.value])), mixedCurrencies: false };
}
function pickCountValue(figures, id) {
  const ok = figures.flatMap((cloud) => {
    const found = cloud.figures.find((figure2) => figure2.id === id);
    return found?.status === "ok" && found.value ? [found.value] : [];
  });
  if (ok.length === 0) {
    return null;
  }
  if (id === "backup") {
    return {
      unprotected: ok.reduce((sum, value) => sum + (Number(value.unprotected) || 0), 0),
      production: ok.reduce((sum, value) => sum + (Number(value.production) || 0), 0),
      undetermined: ok.reduce((sum, value) => sum + (Number(value.undetermined) || 0), 0)
    };
  }
  return { count: ok.reduce((sum, value) => sum + (Number(value.count) || 0), 0) };
}
function combineStatus(figures, id) {
  const statuses = figures.flatMap((cloud) => {
    const found = cloud.figures.find((figure2) => figure2.id === id);
    return found ? [found.status] : [];
  });
  if (statuses.includes("ok")) {
    return "ok";
  }
  if (statuses.includes("not_assessed")) {
    return "not_assessed";
  }
  return "not_supported";
}
function buildHeadline(input) {
  const records = input.records ?? runRecordsFromSpec();
  const selected = input.cloud ? [input.cloud] : [...CLOUDS];
  const clouds = selected.map((cloud) => ({
    cloud,
    figures: buildCloudFigures({
      cloud,
      cost: costForCloud({
        cloud,
        ...input.cost !== void 0 ? { cost: input.cost } : {},
        ...input.costs !== void 0 ? { costs: input.costs } : {}
      }),
      findings: input.findings,
      coverage: input.coverage,
      records,
      now: input.now
    })
  }));
  const figures = [
    figure(
      "monthlyCost",
      "Monthly cost",
      "#cost-and-waste",
      combineStatus(clouds, "monthlyCost"),
      pickMoneyValue(clouds, "monthlyCost")
    ),
    figure(
      "waste",
      "Nameable waste",
      "#issues",
      combineStatus(clouds, "waste"),
      pickMoneyValue(clouds, "waste")
    ),
    figure(
      "backup",
      "Production systems not backed up",
      "#recovery",
      combineStatus(clouds, "backup"),
      pickCountValue(clouds, "backup")
    ),
    figure(
      "lifecycle",
      "Things losing support in 90 days",
      "#lifecycle",
      combineStatus(clouds, "lifecycle"),
      pickCountValue(clouds, "lifecycle")
    ),
    figure(
      "unseen",
      "What Farside could not see",
      "#blind-spots",
      combineStatus(clouds, "unseen"),
      pickCountValue(clouds, "unseen")
    )
  ];
  return {
    sentence: "Your Azure and GCP costs, nameable waste, backup gaps, support losses, and what Farside could not see. Unproven checks are not supported and are left out of every figure. Money figures are per cloud and are never summed across currencies.",
    figures,
    clouds
  };
}

// backend/src/report.ts
var REPORT_FILENAME = "report.html";
var ISSUE_CATEGORIES = ["Waste", "Recovery", "Lifecycle", "Cost", "Other"];
var ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
};
function escapeHtml(value) {
  return value.replace(/[&<>"]/g, (char) => ESCAPE[char] ?? char);
}
function issueCategory(checkId) {
  if (checkId.includes("-waste-")) {
    return "Waste";
  }
  if (checkId.includes("-resilience-")) {
    return "Recovery";
  }
  if (checkId.includes("-lifecycle-")) {
    return "Lifecycle";
  }
  if (checkId.includes("-cost-")) {
    return "Cost";
  }
  return "Other";
}
function sumIssueSavings(rows) {
  const priced = rows.filter((row) => row.savings);
  if (priced.length === 0) {
    return null;
  }
  const currency = priced[0]?.savings?.currency ?? "USD";
  return {
    min: priced.reduce((sum, row) => sum + Number(row.savings?.min ?? 0), 0).toFixed(2),
    max: priced.reduce((sum, row) => sum + Number(row.savings?.max ?? 0), 0).toFixed(2),
    currency
  };
}
function latestCostAmount(rows) {
  const months = rows.filter((row) => !row.provisional);
  return months.at(-1) ?? rows.at(-1) ?? null;
}
function money(min, max, currency) {
  return `${currency} ${min}\u2013${max}`;
}
function renderConsultantReport(input) {
  const waste = sumIssueSavings(input.issues);
  const month = latestCostAmount(input.cost);
  const displayedMonth = month?.amount ?? null;
  const currency = month?.currency ?? waste?.currency ?? "USD";
  const grouped = Object.fromEntries(ISSUE_CATEGORIES.map((name) => [name, []]));
  for (const issue of input.issues) {
    grouped[issueCategory(issue.checkId)].push(issue);
  }
  const undetermined2 = input.findings.filter((finding) => finding.result === "undetermined");
  const spots = blindSpots(input.coverage);
  const assessed = input.coverage.filter((entry) => entry.state === "assessed").length;
  const issueBlocks = ISSUE_CATEGORIES.flatMap((name) => {
    const rows = grouped[name];
    if (rows.length === 0) {
      return [];
    }
    const items = rows.map((issue) => {
      const savings = issue.savings ? `<span data-range-min="${escapeHtml(issue.savings.min)}" data-range-max="${escapeHtml(issue.savings.max)}">${escapeHtml(money(issue.savings.min, issue.savings.max, issue.savings.currency))}</span>` : "\u2014";
      return `<tr data-issue-id="${escapeHtml(issue.id)}"><td>${escapeHtml(issue.id)}</td><td>${escapeHtml(issue.checkId)}</td><td>${escapeHtml(issue.status)}</td><td>${savings}</td></tr>`;
    }).join("");
    return [`<h3>${escapeHtml(name)}</h3><table><thead><tr><th>Issue</th><th>Check</th><th>Status</th><th>Savings</th></tr></thead><tbody>${items}</tbody></table>`];
  });
  const undeterminedItems = undetermined2.map((finding) => {
    const closer = finding.closer ?? "A successful scan of this check on the scope.";
    return `<li><strong>${escapeHtml(finding.checkId)}</strong> \u2014 undetermined. ${escapeHtml(closer)}</li>`;
  }).join("");
  const spotItems = spots.map(
    (spot) => `<li><strong>${escapeHtml(spot.checkId)}</strong> \u2014 ${escapeHtml(spot.state)}. ${escapeHtml(spot.reason)} ${escapeHtml(spot.closer)}</li>`
  ).join("");
  const coverageItems = input.coverage.map(
    (entry) => `<li>${escapeHtml(entry.checkId)} \xB7 ${escapeHtml(entry.subscriptionOrProject)} \xB7 ${escapeHtml(entry.state)}</li>`
  ).join("");
  const wasteMarkup = waste ? `<p data-range-min="${escapeHtml(waste.min)}" data-range-max="${escapeHtml(waste.max)}">Nameable waste ${escapeHtml(money(waste.min, waste.max, waste.currency))}</p>` : "<p>Nameable waste is not assessed.</p>";
  const monthMarkup = displayedMonth ? `<p data-figure="monthlyCost" data-amount="${escapeHtml(displayedMonth)}">Monthly cost ${escapeHtml(currency)} ${escapeHtml(displayedMonth)}</p>` : "<p>Monthly cost is not assessed.</p>";
  return `<!DOCTYPE html>
<html lang="en" data-theme="moonaan">
<head>
<meta charset="utf-8">
<title>Farside report</title>
<style>
:root, :root[data-theme="moonaan"] {
  color-scheme: dark;
  --bg: #07080B;
  --panel: #0B0C10;
  --surface: #12141A;
  --ink: #E6E7EB;
  --muted: #A7ADBB;
  --faint: #6B7180;
  --indigo: #6A7CF7;
  --ever: #2EE6A8;
  --coral: #FF7A70;
  --amber: #F4C95D;
  --color-bg-canvas: var(--bg);
  --color-bg-raised: var(--surface);
  --color-text-primary: var(--ink);
  --color-text-secondary: var(--muted);
  --color-accent: var(--indigo);
  --color-proof: var(--ever);
  --color-alert: var(--coral);
  --color-hold: var(--amber);
  --color-border-subtle: #171A22;
}
:root[data-theme="daylight"] {
  color-scheme: light;
  --bg: #F4F5F8;
  --panel: #FFFFFF;
  --surface: #FFFFFF;
  --ink: #1A1D26;
  --muted: #4C5364;
  --faint: #8B92A3;
  --indigo: #4656D6;
  --ever: #0A9C6E;
  --coral: #D6483C;
  --amber: #8F6400;
  --color-bg-canvas: var(--bg);
  --color-bg-raised: var(--surface);
  --color-text-primary: var(--ink);
  --color-text-secondary: var(--muted);
  --color-accent: var(--indigo);
  --color-proof: var(--ever);
  --color-alert: var(--coral);
  --color-hold: var(--amber);
  --color-border-subtle: #E4E7EE;
}
html { background: var(--color-bg-canvas); color: var(--color-text-primary); font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0 auto; max-width: 52rem; padding: 2rem 1.25rem; }
h1, h2, h3 { color: var(--color-text-primary); }
p, li { color: var(--color-text-secondary); }
table { width: 100%; border-collapse: collapse; background: var(--color-bg-raised); }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--color-border-subtle); color: var(--color-text-primary); }
th { color: var(--color-text-secondary); font-weight: 600; }
.lede { color: var(--color-text-primary); }
@media print {
  :root {
    color-scheme: light;
    --bg: #F4F5F8;
    --panel: #FFFFFF;
    --surface: #FFFFFF;
    --ink: #1A1D26;
    --muted: #4C5364;
    --indigo: #4656D6;
    --ever: #0A9C6E;
    --coral: #D6483C;
    --amber: #8F6400;
    --color-bg-canvas: var(--bg);
    --color-bg-raised: var(--surface);
    --color-text-primary: var(--ink);
    --color-text-secondary: var(--muted);
    --color-accent: var(--indigo);
    --color-proof: var(--ever);
    --color-alert: var(--coral);
    --color-hold: var(--amber);
    --color-border-subtle: #E4E7EE;
  }
}
@media print and (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #07080B;
    --panel: #0B0C10;
    --surface: #12141A;
    --ink: #E6E7EB;
    --muted: #A7ADBB;
    --indigo: #6A7CF7;
    --ever: #2EE6A8;
    --coral: #FF7A70;
    --amber: #F4C95D;
    --color-bg-canvas: var(--bg);
    --color-bg-raised: var(--surface);
    --color-text-primary: var(--ink);
    --color-text-secondary: var(--muted);
    --color-accent: var(--indigo);
    --color-proof: var(--ever);
    --color-alert: var(--coral);
    --color-hold: var(--amber);
    --color-border-subtle: #171A22;
  }
}
</style>
</head>
<body>
<h1>Farside report</h1>
<p class="lede">${escapeHtml(input.headline.sentence)}</p>
<section>
<h2>Headline</h2>
${monthMarkup}
${wasteMarkup}
<p>Assessed coverage scopes: ${String(assessed)}</p>
</section>
<section>
<h2>Issues by category</h2>
${issueBlocks.join("") || "<p>No issues in the export.</p>"}
</section>
<section>
<h2>Undetermined</h2>
${undeterminedItems ? `<ul>${undeterminedItems}</ul>` : "<p>No undetermined results.</p>"}
</section>
<section>
<h2>Blind spots</h2>
${spotItems ? `<ul>${spotItems}</ul>` : "<p>No blind spots.</p>"}
</section>
<section>
<h2>Coverage</h2>
${coverageItems ? `<ul>${coverageItems}</ul>` : "<p>No coverage rows.</p>"}
</section>
</body>
</html>
`;
}
function buildConsultantReport(input) {
  if (input.exportedIssues.format !== EXPORT_FORMAT || input.exportedCost.format !== EXPORT_FORMAT) {
    throw new Error("export format drifted");
  }
  return renderConsultantReport({
    headline: buildHeadline({
      cost: input.cost,
      findings: input.findings,
      coverage: input.coverage,
      now: input.now
    }),
    issues: input.exportedIssues.rows,
    cost: input.exportedCost.rows,
    findings: input.findings,
    coverage: input.coverage
  });
}

// backend/src/cli-credentials.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// backend/src/checks/azure-inventory.ts
var ALL_RESOURCES = "azure-inventory-all-resources";
var NO_OWNER_TAG = "azure-inventory-no-owner-tag";
var ARG_CLOSER = "Grant Reader on that subscription and a successful ARG query";
var OWNER_TAG_CLOSER = "Set the owner tag key in Settings";
var TAGS_CLOSER = "A Resource Graph row for that type that includes tags";
function countByTypeField(resources) {
  const counts = /* @__PURE__ */ new Map();
  for (const resource of resources) {
    counts.set(resource.resourceType, (counts.get(resource.resourceType) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => `${type}:${count}`).join(",");
}
function groupBySubscription(resources, incomplete) {
  const bySubscription = /* @__PURE__ */ new Map();
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
var checkAllResources = checkDefinition({ checkId: ALL_RESOURCES, cloud: "azure" }, (inventory, facts) => {
  const incomplete = new Set(
    facts.filter((row) => row.fields.argIncomplete === true).map((row) => subscriptionOf(row.resourceUri)).filter(Boolean)
  );
  return [...groupBySubscription(inventory.resources, incomplete).entries()].map(([subscription, resources]) => {
    const meta = { checkId: ALL_RESOURCES, cloud: "azure" };
    if (incomplete.has(subscription)) {
      return buildFinding(
        meta,
        subscription,
        undetermined(ARG_CLOSER, {
          subscriptionId: subscription,
          resourceId: null,
          type: null,
          location: null,
          countByType: null
        })
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
        resourceCount: resources.length
      })
    );
  });
});
function firstPerScope(resources, scopeOf2) {
  const firsts = /* @__PURE__ */ new Map();
  for (const resource of resources) {
    const scope4 = scopeOf2(resource.resourceUri);
    if (scope4 && !firsts.has(scope4)) {
      firsts.set(scope4, resource);
    }
  }
  return [...firsts.values()];
}
var checkNoOwnerTag = defineAzureCheck({
  checkId: NO_OWNER_TAG,
  select: (resources, { settings, scopeOf: scopeOf2 }) => settings.ownerTagKey.length > 0 ? resources : firstPerScope(resources, scopeOf2),
  readFacts: (_resource, fields) => ({ tagsAbsent: fields?.tagsPresent === false }),
  decide: ({ tagsAbsent }, { resource, settings }) => {
    const ownerTagKey = settings.ownerTagKey;
    if (ownerTagKey.length === 0) {
      return undetermined(OWNER_TAG_CLOSER, {
        resourceId: null,
        type: null,
        tagsPresent: null,
        ownerTagKey: null,
        ownerTagValue: null
      });
    }
    const evidence = (tagsPresent, ownerTagValue) => ({
      resourceId: resource.resourceUri,
      type: resource.resourceType,
      tagsPresent,
      ownerTagKey,
      ownerTagValue
    });
    if (tagsAbsent) {
      return undetermined(TAGS_CLOSER, evidence(false, null));
    }
    const owner = resource.ownerTag;
    return owner ? pass(evidence(true, owner)) : fail(evidence(true, owner ?? null));
  }
});

// docs/azure/retiring-skus.json
var retiring_skus_default = {
  version: 1,
  publishedAt: "2026-11-02",
  source: "docs/azure/retiring-skus.json",
  note: "In-repo Farside test catalogue. Not a live Azure retirement announcement. Refresh by editing this file.",
  entries: [
    {
      skuName: "Standard_B1ls",
      resourceType: "Microsoft.Compute/virtualMachines",
      retirementDate: "2026-12-31",
      announcementId: "farside-test-b1ls",
      source: "docs/azure/retiring-skus.json"
    }
  ]
};

// backend/src/retiring.ts
function loadRetiringSkus() {
  return retiring_skus_default;
}

// backend/src/checks/azure-lifecycle.ts
var RETIRING_SKUS = "azure-lifecycle-retiring-skus";
var EXPIRING_APP_CERTS = "azure-lifecycle-expiring-app-service-certs";
var EXPIRING_GATEWAY_CERTS = "azure-lifecycle-expiring-gateway-certs";
var checkRetiringSkus = defineAzureCheck({
  checkId: RETIRING_SKUS,
  prepare: () => {
    const catalogue = loadRetiringSkus();
    return { catalogue, bySku: new Map(catalogue.entries.map((entry) => [entry.skuName, entry])) };
  },
  readFacts: (_resource, fields) => str(fields, "skuName") ?? str(fields, "vmSize"),
  decide: (skuName, { resource, shared: { catalogue, bySku } }) => {
    if (skuName === null) {
      return null;
    }
    const identity = {
      resourceUri: resource.resourceUri,
      resourceId: resource.resourceUri.split("/").pop() ?? resource.displayName,
      skuName
    };
    const listed = bySku.get(skuName);
    if (listed) {
      return fail({
        ...identity,
        retirementDate: listed.retirementDate,
        announcementId: listed.announcementId,
        source: listed.source
      });
    }
    return pass({
      ...identity,
      catalogueVersion: catalogue.version,
      cataloguePublishedAt: catalogue.publishedAt,
      source: catalogue.source
    });
  }
});
function expiringCertsCheck(spec) {
  return defineAzureCheck({
    checkId: spec.checkId,
    resourceType: spec.resourceType,
    readFacts: (resource, fields, settings) => ({
      threshold: settings.certExpiryFlagDays,
      id: str(fields, spec.idField) ?? resource.displayName,
      name: str(fields, spec.nameField),
      expirationDate: str(fields, "expirationDate"),
      daysRemaining: num(fields, "daysRemaining")
    }),
    decide: ({ threshold, id, name, expirationDate, daysRemaining }, { resource }) => {
      const evidence = (days) => ({
        resourceUri: resource.resourceUri,
        [spec.idField]: id,
        [spec.nameField]: name,
        expirationDate,
        daysRemaining: days
      });
      if (!(threshold > 0)) {
        return undetermined("Set certificate expiry warning days in Settings", evidence(null));
      }
      if (daysRemaining === null) {
        return undetermined("A certificate read that includes expirationDate", evidence(null));
      }
      return daysRemaining <= threshold ? fail(evidence(daysRemaining)) : pass(evidence(daysRemaining));
    }
  });
}
var checkExpiringAppCerts = expiringCertsCheck({
  checkId: EXPIRING_APP_CERTS,
  resourceType: "Microsoft.Web/certificates",
  idField: "certificateId",
  nameField: "hostName"
});
var checkExpiringGatewayCerts = expiringCertsCheck({
  checkId: EXPIRING_GATEWAY_CERTS,
  resourceType: "Microsoft.Network/applicationGateways",
  idField: "gatewayId",
  nameField: "certificateName"
});

// backend/src/checks/azure-resilience.ts
var PROD_VM_BACKUP = "azure-resilience-prod-vms-outside-backup";
var PROD_SQL_BACKUP = "azure-resilience-prod-sql-outside-backup";
var DB_ZONE_OR_GEO = "azure-resilience-db-zone-or-geo";
var MARKER_CLOSER = "Set the production tag or name pattern in Settings";
function configuredMarker(settings) {
  if (settings.productionTagKey.length === 0 || settings.productionTagValue.length === 0) {
    return null;
  }
  return `${settings.productionTagKey}=${settings.productionTagValue}`;
}
function productionBackupCheck(spec) {
  return defineAzureCheck({
    checkId: spec.checkId,
    resourceType: spec.resourceType,
    select: (resources, { settings }) => configuredMarker(settings) ? resources.filter((resource) => resource.tags[settings.productionTagKey] === settings.productionTagValue) : resources,
    prepare: (production, { rows, settings }) => ({
      marker: configuredMarker(settings),
      productionCount: production.length,
      unprotectedCount: production.filter(
        (resource) => rows.get(resource.resourceUri)?.fields.protected === false
      ).length
    }),
    readFacts: (resource, fields) => ({
      id: str(fields, spec.idField) ?? resource.displayName,
      vaultId: str(fields, "vaultId"),
      protectedState: bool(fields, "protected")
    }),
    decide: ({ id, vaultId, protectedState }, { resource, shared }) => {
      const { marker, productionCount, unprotectedCount } = shared;
      const evidence = (state, vault) => ({
        resourceUri: resource.resourceUri,
        [spec.idField]: id,
        productionMarker: marker,
        vaultId: vault,
        protected: state
      });
      if (!marker) {
        return undetermined(MARKER_CLOSER, evidence(null, null));
      }
      if (protectedState === null) {
        return undetermined(spec.roleCloser, evidence(null, vaultId));
      }
      return protectedState ? pass({ ...evidence(true, vaultId), productionCount }) : fail({ ...evidence(false, vaultId), unprotectedCount, productionCount });
    }
  });
}
var checkProdVmBackup = productionBackupCheck({
  checkId: PROD_VM_BACKUP,
  resourceType: "Microsoft.Compute/virtualMachines",
  idField: "vmId",
  roleCloser: "Backup Reader on the vaults in scope"
});
var checkProdSqlBackup = productionBackupCheck({
  checkId: PROD_SQL_BACKUP,
  resourceType: "Microsoft.Sql/servers/databases",
  idField: "sqlResourceId",
  roleCloser: "Backup Reader on the relevant vaults and a list of SQL backup items"
});
var checkDbZoneOrGeo = defineAzureCheck({
  checkId: DB_ZONE_OR_GEO,
  resourceType: "Microsoft.Sql/servers/databases",
  readFacts: (database, fields) => ({
    databaseId: str(fields, "databaseId") ?? database.displayName,
    engine: str(fields, "engine"),
    zoneRedundant: bool(fields, "zoneRedundant"),
    backupRedundancy: str(fields, "backupRedundancy")
  }),
  decide: ({ databaseId, engine, zoneRedundant, backupRedundancy }, { resource: database }) => {
    const evidence = { resourceUri: database.resourceUri, databaseId, engine, zoneRedundant, backupRedundancy };
    if (zoneRedundant === null || backupRedundancy === null) {
      return undetermined("A database read that includes those properties for that engine", evidence);
    }
    const missing = [
      zoneRedundant ? null : "zone redundancy",
      /geo/i.test(backupRedundancy) ? null : "geo-backup"
    ].filter((item) => item !== null);
    return missing.length > 0 ? fail({ ...evidence, missingSetting: missing.join(" and ") }) : pass(evidence);
  }
});

// backend/src/checks/azure-waste.ts
var UNATTACHED_DISKS = "azure-waste-unattached-disks";
var OLD_SNAPSHOTS = "azure-waste-old-snapshots";
var UNASSOCIATED_IPS = "azure-waste-unassociated-public-ips";
var STOPPED_VMS = "azure-waste-stopped-not-deallocated-vms";
var EMPTY_PLANS = "azure-waste-empty-app-service-plans";
var IDLE_LOAD_BALANCERS = "azure-waste-idle-load-balancers";
var IDLE_NAT_GATEWAYS = "azure-waste-idle-nat-gateways";
var METRICS_CLOSER = "Monitoring Reader and a metric series over a longer window";
var checkUnattachedDisks = defineAzureCheck({
  checkId: UNATTACHED_DISKS,
  resourceType: "Microsoft.Compute/disks",
  readFacts: (disk, fields) => ({
    state: str(fields, "diskState"),
    sizeGb: num(fields, "sizeGb"),
    diskId: str(fields, "diskId") ?? disk.displayName,
    skuName: str(fields, "skuName")
  }),
  decide: ({ state, sizeGb, diskId, skuName }, { resource: disk }) => {
    const evidence = { resourceUri: disk.resourceUri, diskId, diskState: state, skuName: null, sizeGb, location: disk.region };
    if (state === null) {
      return undetermined("A disk read that includes diskState and managedBy", {
        ...evidence,
        diskId: disk.displayName
      });
    }
    if (state !== "Unattached") {
      return pass(evidence);
    }
    if (sizeGb === null || sizeGb <= 0) {
      return undetermined("A retail or agreement price row for the SKU in that region", {
        ...evidence,
        sizeGb: null
      });
    }
    return fail({ ...evidence, skuName }, diskMonthlySavings(sizeGb));
  }
});
var checkOldSnapshots = defineAzureCheck({
  checkId: OLD_SNAPSHOTS,
  resourceType: "Microsoft.Compute/snapshots",
  readFacts: (snapshot, fields, settings) => ({
    threshold: settings.snapshotRetentionDays,
    ageDays: num(fields, "ageDays"),
    snapshotId: str(fields, "snapshotId") ?? snapshot.displayName
  }),
  decide: ({ threshold, ageDays, snapshotId }, { resource: snapshot }) => {
    const uri = snapshot.resourceUri;
    if (!(threshold > 0)) {
      return undetermined("Set snapshot retention days in Settings", {
        resourceUri: uri,
        snapshotId: snapshot.displayName,
        retentionDays: null
      });
    }
    if (ageDays === null) {
      return undetermined("A snapshot read that includes timeCreated", {
        resourceUri: uri,
        snapshotId,
        ageDays: null,
        retentionDays: threshold
      });
    }
    const evidence = { resourceUri: uri, snapshotId, ageDays, retentionDays: threshold };
    return ageDays > threshold ? fail(evidence, snapshotMonthlySavings()) : pass(evidence);
  }
});
var checkUnassociatedIps = defineAzureCheck({
  checkId: UNASSOCIATED_IPS,
  resourceType: "Microsoft.Network/publicIPAddresses",
  readFacts: (ip, fields) => ({
    known: fields !== void 0 && Object.hasOwn(fields, "associatedTo"),
    associatedTo: fields?.associatedTo ?? null,
    publicIpId: str(fields, "publicIpId") ?? ip.displayName
  }),
  decide: ({ known, associatedTo, publicIpId }, { resource: ip }) => {
    if (!known) {
      return undetermined("A public IP read that includes ipConfiguration / natGateway / associated resource", {
        resourceUri: ip.resourceUri,
        publicIpId: ip.displayName,
        associatedTo: null
      });
    }
    if (associatedTo === null || associatedTo === "") {
      return fail({ resourceUri: ip.resourceUri, publicIpId, associatedTo: null }, publicIpMonthlySavings());
    }
    return pass({ resourceUri: ip.resourceUri, publicIpId, associatedTo });
  }
});
var checkStoppedVms = defineAzureCheck({
  checkId: STOPPED_VMS,
  resourceType: "Microsoft.Compute/virtualMachines",
  readFacts: (vm, fields) => ({
    powerState: str(fields, "powerState"),
    vmId: str(fields, "vmId") ?? vm.displayName,
    vmSize: str(fields, "vmSize")
  }),
  decide: ({ powerState, vmId, vmSize }, { resource: vm }) => {
    if (powerState === null) {
      return undetermined("A VM instance-view read that includes powerState", {
        resourceUri: vm.resourceUri,
        vmId: vm.displayName,
        powerState: null,
        vmSize: null,
        location: vm.region
      });
    }
    const evidence = { resourceUri: vm.resourceUri, vmId, powerState, vmSize, location: vm.region };
    return powerState === "stopped" ? fail(evidence, stoppedVmMonthlySavings()) : pass(evidence);
  }
});
var checkEmptyPlans = defineAzureCheck({
  checkId: EMPTY_PLANS,
  resourceType: "Microsoft.Web/serverfarms",
  readFacts: (plan, fields) => ({
    numberOfSites: num(fields, "numberOfSites"),
    planId: str(fields, "planId") ?? plan.displayName,
    skuName: str(fields, "skuName"),
    kind: str(fields, "kind")
  }),
  decide: ({ numberOfSites, planId, skuName, kind }, { resource: plan }) => {
    const evidence = { resourceUri: plan.resourceUri, planId, skuName, numberOfSites, kind };
    if (numberOfSites === null) {
      return undetermined("A plan read that includes numberOfSites, or a complete sites list", evidence);
    }
    return numberOfSites === 0 ? fail(evidence, emptyPlanMonthlySavings()) : pass(evidence);
  }
});
function idleTrafficCheck(spec) {
  return defineAzureCheck({
    checkId: spec.checkId,
    resourceType: spec.resourceType,
    readFacts: (resource, fields) => ({
      id: str(fields, spec.idField) ?? resource.displayName,
      skuName: str(fields, "skuName"),
      count: num(fields, spec.countField),
      metricWindow: str(fields, "metricWindow"),
      byteCount: num(fields, "byteCount")
    }),
    decide: ({ id, skuName, count, metricWindow, byteCount }, { resource }) => {
      const evidence = (seenCount, window) => ({
        resourceUri: resource.resourceUri,
        [spec.idField]: id,
        ...spec.countBeforeSku ? { [spec.countField]: seenCount, skuName } : { skuName, [spec.countField]: seenCount },
        metricWindow: window
      });
      if (count === null) {
        return undetermined(spec.countCloser, evidence(null, null));
      }
      if (!metricWindow || byteCount === null) {
        return undetermined(METRICS_CLOSER, evidence(count, null));
      }
      const traffic = evidence(count, metricWindow);
      return count === 0 || byteCount === 0 ? fail(traffic, spec.savings()) : pass(traffic);
    }
  });
}
var checkIdleLoadBalancers = idleTrafficCheck({
  checkId: IDLE_LOAD_BALANCERS,
  resourceType: "Microsoft.Network/loadBalancers",
  idField: "loadBalancerId",
  countField: "backendAddressCount",
  countCloser: "A load balancer read that includes backend address pools",
  savings: idleLbMonthlySavings
});
var checkIdleNatGateways = idleTrafficCheck({
  checkId: IDLE_NAT_GATEWAYS,
  resourceType: "Microsoft.Network/natGateways",
  idField: "natGatewayId",
  countField: "attachedSubnetCount",
  countBeforeSku: true,
  countCloser: "A NAT gateway read that includes subnets",
  savings: idleNatMonthlySavings
});

// backend/src/facts.ts
function resourceUriFor(item) {
  return `/subscriptions/${item.subscription}/resourceGroups/farside-seed/providers/${item.type}/${item.id}`;
}
function factsFromManifest(manifest) {
  return manifest.items.map((item) => {
    const fields = {
      location: "eastus",
      ...item.properties ?? {}
    };
    if (item.type === "Microsoft.Compute/disks") {
      fields.diskId = item.id;
    }
    if (item.type === "Microsoft.Compute/snapshots") {
      fields.snapshotId = item.id;
    }
    if (item.type === "Microsoft.Network/publicIPAddresses") {
      fields.publicIpId = item.id;
    }
    if (item.type === "Microsoft.Compute/virtualMachines") {
      fields.vmId = item.id;
    }
    if (item.type === "Microsoft.Web/serverfarms") {
      fields.planId = item.id;
    }
    if (item.type === "Microsoft.Network/loadBalancers") {
      fields.loadBalancerId = item.id;
    }
    if (item.type === "Microsoft.Network/natGateways") {
      fields.natGatewayId = item.id;
    }
    if (item.type === "Microsoft.Sql/servers/databases") {
      fields.sqlResourceId = item.id;
      fields.databaseId = item.id;
    }
    if (item.type === "Microsoft.Web/certificates") {
      fields.certificateId = item.id;
    }
    if (item.type === "Microsoft.Network/applicationGateways") {
      fields.gatewayId = item.id;
    }
    return { resourceUri: resourceUriFor(item), fields };
  });
}

// backend/src/scope.ts
function scopeOf(cloud, resourceUri) {
  return providerFor(cloud).scopeOf(resourceUri);
}

// backend/src/inventory.ts
var ALLOWED_ITEM_KEYS = /* @__PURE__ */ new Set(["id", "subscription", "type", "title", "properties", "tags"]);
function stripProviderPayload(item) {
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (ALLOWED_ITEM_KEYS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}
function toInventoryRecord(item, ownerTagKey) {
  const owner = item.tags[ownerTagKey];
  return {
    resourceUri: `/subscriptions/${item.subscription}/resourceGroups/farside-seed/providers/${item.type}/${item.id}`,
    resourceType: item.type,
    region: "eastus",
    displayName: item.title,
    tags: { ...item.tags },
    ownerTag: owner && owner.length > 0 ? owner : null
  };
}
function inventoryFromManifest(manifest, observedAt = "1970-01-01T00:00:00.000Z") {
  const inventory = {
    cloud: "azure",
    observedAt,
    resources: manifest.items.map(
      (item) => toInventoryRecord(
        stripProviderPayload(item),
        manifest.ownerTagKey
      )
    )
  };
  assertValid(validateInventory(inventory));
  return inventory;
}
function applyOwnerTag(inventory, ownerTagKey) {
  return {
    ...inventory,
    resources: inventory.resources.map((resource) => {
      const owner = resource.tags[ownerTagKey];
      return {
        ...resource,
        ownerTag: owner && owner.length > 0 ? owner : null
      };
    })
  };
}

// backend/src/roles.ts
var REQUIRED_AZURE_ROLES = [
  "Reader",
  "Cost Management Reader",
  "Monitoring Reader",
  "Reservations Reader"
];
var OPTIONAL_AZURE_ROLES = ["Backup Reader"];

// backend/src/abortable.ts
var MAX_TIMER_MS = 2 ** 31 - 1;
function abortable(signal, work, timeoutMs) {
  if (signal.aborted) {
    return Promise.reject(new Error("scan aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => settle(() => reject(new Error("scan aborted")));
    const timer = setTimeout(() => {
      const error = new Error(`harvest exceeded ${timeoutMs}ms`);
      error.name = "TimeoutError";
      settle(() => reject(error));
    }, Math.min(timeoutMs, MAX_TIMER_MS));
    const settle = (finish) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}

// backend/src/readonly.ts
var asMutable = (value) => value;

// backend/src/providers/launch-ids.ts
var AZURE_LAUNCH_CHECK_IDS = [
  "azure-inventory-all-resources",
  "azure-inventory-no-owner-tag",
  "azure-waste-unattached-disks",
  "azure-waste-unassociated-public-ips",
  "azure-waste-old-snapshots",
  "azure-waste-stopped-not-deallocated-vms",
  "azure-waste-empty-app-service-plans",
  "azure-waste-idle-load-balancers",
  "azure-waste-idle-nat-gateways",
  "azure-cost-spend-by-service",
  "azure-cost-month-on-month",
  "azure-cost-reservation-use",
  "azure-cost-savings-plan-use",
  "azure-cost-subscriptions-without-budgets",
  "azure-resilience-prod-vms-outside-backup",
  "azure-resilience-prod-sql-outside-backup",
  "azure-resilience-db-zone-or-geo",
  "azure-lifecycle-retiring-skus",
  "azure-lifecycle-expiring-app-service-certs",
  "azure-lifecycle-expiring-gateway-certs"
];
var GCP_LAUNCH_CHECK_IDS = [
  "gcp-inventory-all-assets",
  "gcp-inventory-no-owner-label",
  "gcp-waste-unattached-disks",
  "gcp-waste-unused-external-ips",
  "gcp-waste-old-snapshots-and-images",
  "gcp-waste-idle-vm-and-disk-recommendations",
  "gcp-cost-spend-by-service",
  "gcp-cost-committed-use",
  "gcp-resilience-sql-ha-or-backup",
  "gcp-lifecycle-sql-gke-support",
  "gcp-lifecycle-expiring-certs"
];
var AZURE_HARVEST_ASSESSED_CHECK_IDS = /* @__PURE__ */ new Set([
  "azure-inventory-all-resources",
  "azure-inventory-no-owner-tag"
]);
var GCP_HARVEST_ASSESSED_CHECK_IDS = /* @__PURE__ */ new Set([
  "gcp-inventory-all-assets",
  "gcp-inventory-no-owner-label"
]);

// backend/src/providers/azure-harvests.ts
function fillUnrunLaunchCoverage(coverage, subscriptionId) {
  let next = coverage;
  for (const checkId of AZURE_LAUNCH_CHECK_IDS) {
    if (next.some((entry) => entry.checkId === checkId && entry.subscriptionOrProject === subscriptionId)) {
      continue;
    }
    next = applyCoverageResult(
      next,
      recordCoverageScope({
        subscriptionOrProject: subscriptionId,
        checkId,
        state: "unassessed",
        causeId: "not_run"
      })
    );
  }
  return next;
}
async function persistAzureHarvests({ orgId, subscriptionId, store }, collected) {
  if (collected.cost) {
    await store.putCost(orgId, collected.cost.ok ? collected.cost.snapshot : null, subscriptionId);
  }
  if (collected.commitments) {
    await store.putCommitments(
      orgId,
      collected.commitments.ok ? collected.commitments.snapshot : null,
      subscriptionId
    );
  }
  if (collected.budgets) {
    const { budgets } = await store.read(orgId, "budgets");
    await store.putBudgets(orgId, mergeBudgetSnapshot(asMutable(budgets), collected.budgets.snapshot));
  }
}
function applyAzureHarvests({ subscriptionId }, collected, outputs) {
  let { findings, coverage } = outputs;
  if (collected.cost) {
    coverage = applyCostCoverage(coverage, collected.cost.coverage);
  }
  if (collected.commitments) {
    coverage = applyCommitmentCoverage(coverage, collected.commitments.coverage);
    if (collected.commitments.ok) {
      findings = mergeCommitmentFindings(findings, collected.commitments.findings, subscriptionId);
    }
  }
  if (collected.budgets) {
    coverage = applyBudgetCoverage(coverage, collected.budgets.coverage);
    findings = mergeBudgetFindings(
      findings,
      collected.budgets.findings,
      collected.budgets.snapshot.subscriptions.map((row) => row.subscriptionId)
    );
  }
  return { findings, coverage: fillUnrunLaunchCoverage(coverage, subscriptionId) };
}
async function collectAzureHarvests(context) {
  const { subscriptionId, signal, remainingMs, clock, clients } = context;
  const billingScope = `/subscriptions/${subscriptionId}`;
  const collected = {};
  if (clients.costClient) {
    collected.cost = await abortable(
      signal,
      harvestCost({
        client: clients.costClient,
        subscriptionId,
        billingScope,
        agreementType: "payg",
        asOf: clock()
      }),
      remainingMs()
    );
    if (signal.aborted) {
      return null;
    }
  }
  if (clients.commitmentClient) {
    collected.commitments = await abortable(
      signal,
      harvestCommitments({ client: clients.commitmentClient, subscriptionId, billingScope }),
      remainingMs()
    );
    if (signal.aborted) {
      return null;
    }
  }
  if (clients.budgetClient) {
    collected.budgets = await abortable(
      signal,
      harvestBudgets({ client: clients.budgetClient, lastConfirmed: clock() }),
      remainingMs()
    );
    if (signal.aborted) {
      return null;
    }
  }
  return {
    persist: () => persistAzureHarvests(context, collected),
    apply: (outputs) => applyAzureHarvests(context, collected, outputs)
  };
}

// backend/src/providers/fixture-harvester.ts
function fixtureHarvester(inventory, facts = [], clock) {
  return {
    async harvest(input) {
      const provider = providerFor(inventory.cloud);
      const coverage = coverageFromHarvest(
        [input.subscriptionId],
        provider.launchCheckIds,
        provider.harvestAssessedCheckIds
      );
      return {
        inventory: applyOwnerTag(
          clock ? { ...inventory, observedAt: clock() } : inventory,
          input.settings.ownerTagKey
        ),
        coverage,
        coveredScopes: coverage.filter((entry) => entry.state === "assessed").map((entry) => entry.id),
        facts
      };
    }
  };
}

// backend/src/providers/azure.ts
var azureProvider = {
  cloud: "azure",
  launchCheckIds: AZURE_LAUNCH_CHECK_IDS,
  harvestAssessedCheckIds: AZURE_HARVEST_ASSESSED_CHECK_IDS,
  requiredRoles: REQUIRED_AZURE_ROLES,
  optionalRoles: OPTIONAL_AZURE_ROLES,
  scopeOf: subscriptionOf,
  harvester: (clock) => {
    const manifest = ground_truth_default;
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
    checkExpiringGatewayCerts
  ],
  collectHarvests: collectAzureHarvests
};

// backend/src/gcp-checks.ts
var GCP_UNATTACHED_DISKS = "gcp-waste-unattached-disks";
var GCP_UNUSED_IPS = "gcp-waste-unused-external-ips";
var GCP_OLD_SNAPSHOTS_AND_IMAGES = "gcp-waste-old-snapshots-and-images";
var checkGcpUnattachedDisks = defineGcpCheck({
  checkId: GCP_UNATTACHED_DISKS,
  resourceType: "compute.googleapis.com/Disk",
  readFacts: (disk, fields) => ({
    usersCount: num(fields, "usersCount"),
    sizeGb: num(fields, "sizeGb"),
    diskId: nonEmptyStr(fields, "diskId") ?? disk.displayName,
    zone: nonEmptyStr(fields, "location") ?? disk.region
  }),
  decide: ({ usersCount, sizeGb, diskId, zone }, { resource: disk }) => {
    const evidence = { resourceUri: disk.resourceUri, diskId, usersCount, sizeGb, zone };
    if (usersCount === null) {
      return undetermined("A disk read that includes the users list", evidence);
    }
    if (usersCount !== 0) {
      return pass(evidence);
    }
    if (sizeGb === null || sizeGb <= 0) {
      return undetermined("A disk read that includes sizeGb", { ...evidence, sizeGb: null });
    }
    return fail(evidence, gcpDiskMonthlySavings(sizeGb));
  }
});
var checkGcpUnusedIps = defineGcpCheck({
  checkId: GCP_UNUSED_IPS,
  resourceType: "compute.googleapis.com/Address",
  readFacts: (address, fields) => ({
    status: str(fields, "status"),
    usersCount: num(fields, "usersCount"),
    addressId: nonEmptyStr(fields, "addressId") ?? address.displayName,
    ip: nonEmptyStr(fields, "address") ?? address.displayName,
    region: nonEmptyStr(fields, "location") ?? address.region
  }),
  decide: ({ status, usersCount, addressId, ip, region }, { resource: address }) => {
    const evidence = { resourceUri: address.resourceUri, addressId, address: ip, status, usersCount, region };
    if (status === null || usersCount === null) {
      return undetermined("An address read that includes status and users", evidence);
    }
    return status === "RESERVED" && usersCount === 0 ? fail(evidence, gcpIpMonthlySavings()) : pass(evidence);
  }
});
var checkGcpOldSnapshotsAndImages = defineGcpCheck({
  checkId: GCP_OLD_SNAPSHOTS_AND_IMAGES,
  resourceType: ["compute.googleapis.com/Snapshot", "compute.googleapis.com/Image"],
  readFacts: (item, fields, settings) => ({
    threshold: settings.snapshotRetentionDays,
    snapshotOrImageId: nonEmptyStr(fields, "snapshotOrImageId") ?? item.displayName,
    creationTimestamp: str(fields, "creationTimestamp"),
    ageDays: num(fields, "ageDays"),
    sizeGb: num(fields, "sizeGb")
  }),
  decide: ({ threshold, snapshotOrImageId, creationTimestamp, ageDays, sizeGb }, { resource: item }) => {
    const evidence = {
      resourceUri: item.resourceUri,
      snapshotOrImageId,
      creationTimestamp,
      ageDays,
      retentionDays: threshold
    };
    if (!(threshold > 0)) {
      return undetermined("Set snapshot retention days in Settings", {
        ...evidence,
        ageDays: null,
        retentionDays: null
      });
    }
    if (ageDays === null) {
      return undetermined("A snapshot or image read that includes creationTimestamp", evidence);
    }
    if (ageDays <= threshold) {
      return pass(evidence);
    }
    if (sizeGb === null || sizeGb <= 0) {
      return undetermined("A snapshot or image read that includes sizeGb", evidence);
    }
    return fail(evidence, gcpSnapshotImageMonthlySavings(sizeGb));
  }
});

// backend/src/gcp-inventory.ts
var COLLECTIONS = {
  Disk: "disks",
  Address: "addresses",
  Snapshot: "snapshots",
  Image: "images",
  Instance: "instances",
  Cluster: "clusters",
  Certificate: "certificates",
  Recommendation: "recommendations"
};
var ALLOWED_ITEM_KEYS2 = /* @__PURE__ */ new Set(["id", "project", "type", "title", "region", "properties", "labels"]);
function stripGcpPayload(item) {
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (ALLOWED_ITEM_KEYS2.has(key)) {
      out[key] = value;
    }
  }
  return out;
}
function gcpResourceUri(item) {
  const [service, kind] = item.type.split("/");
  const collection = kind && COLLECTIONS[kind] || "resources";
  if (item.region === "global") {
    return `//${service}/projects/${item.project}/global/${collection}/${item.id}`;
  }
  if (service === "container.googleapis.com") {
    return `//${service}/projects/${item.project}/locations/${item.region}/${collection}/${item.id}`;
  }
  if (/-[a-z]$/.test(item.region)) {
    return `//${service}/projects/${item.project}/zones/${item.region}/${collection}/${item.id}`;
  }
  return `//${service}/projects/${item.project}/regions/${item.region}/${collection}/${item.id}`;
}
function toGcpInventoryRecord(item, ownerLabelKey) {
  const owner = item.labels[ownerLabelKey];
  return {
    resourceUri: gcpResourceUri(item),
    resourceType: item.type,
    region: item.region,
    displayName: item.title,
    tags: { ...item.labels },
    ownerTag: owner && owner.length > 0 ? owner : null
  };
}
function inventoryFromGcpManifest(manifest, observedAt = "1970-01-01T00:00:00.000Z") {
  const inventory = {
    cloud: "gcp",
    observedAt,
    resources: manifest.items.map(
      (item) => toGcpInventoryRecord(
        stripGcpPayload(item),
        manifest.ownerLabelKey
      )
    )
  };
  assertValid(validateInventory(inventory));
  return inventory;
}
function factsFromGcpManifest(manifest) {
  return manifest.items.map((item) => {
    const fields = {
      location: item.region,
      ...item.properties ?? {}
    };
    if (item.type === "compute.googleapis.com/Disk") {
      fields.diskId = item.id;
    }
    if (item.type === "compute.googleapis.com/Address") {
      fields.addressId = item.id;
    }
    if (item.type === "compute.googleapis.com/Snapshot") {
      fields.snapshotOrImageId = item.id;
    }
    if (item.type === "compute.googleapis.com/Image") {
      fields.snapshotOrImageId = item.id;
    }
    if (item.type === "sqladmin.googleapis.com/Instance") {
      fields.resourceKind = "sql";
      fields.instanceName = item.id;
      fields.projectId = item.project;
    }
    if (item.type === "container.googleapis.com/Cluster") {
      fields.resourceKind = "gke";
    }
    if (item.type === "certificatemanager.googleapis.com/Certificate") {
      fields.certificateId = item.id;
    }
    if (item.type === "recommender.googleapis.com/Recommendation") {
      fields.recommendationId = item.id;
      fields.projectId = item.project;
    }
    return { resourceUri: gcpResourceUri(item), fields };
  });
}

// docs/gcp/commitments.json
var commitments_default2 = {
  note: "Fake GCP committed-use discount rows for E6-S6-T2. Not a live billing export.",
  projectId: "farside-test",
  billingAccountId: "billing-farside-test",
  commitments: [
    {
      commitmentName: "cud-low",
      utilizationPercent: 40,
      committedAmount: 100,
      usedAmount: 40,
      currency: "USD"
    },
    {
      commitmentName: "cud-used",
      utilizationPercent: 95,
      committedAmount: 80,
      usedAmount: 76,
      currency: "USD"
    }
  ]
};

// backend/src/gcp-commitments.ts
var GCP_COMMITTED_USE = "gcp-cost-committed-use";
var CUD_LOW_UTILISATION_PERCENT = 80;
var CUD_EXPORT_CLOSER = "Enable the BigQuery billing export";
var FIXTURE2 = commitments_default2;
function acceptFinding2(finding) {
  assertValid(validateFinding(finding));
  return finding;
}
function scope2(projectId) {
  return {
    id: `${projectId}:${GCP_COMMITTED_USE}`,
    cloud: "gcp",
    subscriptionOrProject: projectId
  };
}
function fixtureCudHarvest() {
  return {
    ok: true,
    billingAccountId: FIXTURE2.billingAccountId,
    commitments: FIXTURE2.commitments
  };
}
function checkGcpCommittedUse(projectId, harvest) {
  if (!harvest.ok) {
    return {
      findings: [
        acceptFinding2({
          checkId: GCP_COMMITTED_USE,
          result: "undetermined",
          closer: CUD_EXPORT_CLOSER,
          evidence: {
            fields: {
              billingAccountId: null,
              commitmentName: null,
              utilizationPercent: null,
              missingExport: true
            }
          },
          scope: scope2(projectId)
        })
      ],
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: projectId,
          checkId: GCP_COMMITTED_USE,
          state: "unassessed",
          causeId: "missing_role",
          closer: CUD_EXPORT_CLOSER
        })
      ]
    };
  }
  if (harvest.commitments.length === 0) {
    return {
      findings: [
        acceptFinding2({
          checkId: GCP_COMMITTED_USE,
          result: "pass",
          evidence: {
            fields: {
              noneFound: true,
              commitmentCount: 0,
              billingAccountId: harvest.billingAccountId ?? null
            }
          },
          scope: scope2(projectId)
        })
      ],
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: projectId,
          checkId: GCP_COMMITTED_USE,
          state: "assessed"
        })
      ]
    };
  }
  const findings = harvest.commitments.map((row) => {
    const unused = Math.max(row.committedAmount - row.usedAmount, 0);
    const low = row.utilizationPercent < CUD_LOW_UTILISATION_PERCENT;
    const savings = low && unused > 0 ? unusedCudSavings(unused, row.currency) : null;
    return acceptFinding2({
      checkId: GCP_COMMITTED_USE,
      result: low ? "fail" : "pass",
      evidence: {
        fields: {
          billingAccountId: harvest.billingAccountId ?? row.billingAccountId ?? null,
          commitmentName: row.commitmentName,
          utilizationPercent: row.utilizationPercent,
          currency: row.currency,
          ...savings ? { savingsBasis: GCP_CUD_SAVINGS_BASIS } : {}
        }
      },
      scope: scope2(projectId),
      ...savings ? { savings: { min: savings.min, max: savings.max, currency: savings.currency } } : {}
    });
  });
  return {
    findings,
    coverage: [
      recordCoverageScope({
        subscriptionOrProject: projectId,
        checkId: GCP_COMMITTED_USE,
        state: "assessed"
      })
    ]
  };
}
var checkGcpCud = checkDefinition({ checkId: GCP_COMMITTED_USE, cloud: "gcp" }, (inventory) => {
  const projects = new Set(inventory.resources.map((resource) => projectOf(resource.resourceUri)));
  const findings = [];
  for (const projectId of projects) {
    findings.push(...checkGcpCommittedUse(projectId, fixtureCudHarvest()).findings);
  }
  return findings;
});

// backend/src/gcp-lifecycle.ts
var GCP_EXPIRING_CERTS = "gcp-lifecycle-expiring-certs";
var CERT_TYPE = "certificatemanager.googleapis.com/Certificate";
var checkGcpExpiringCerts = defineGcpCheck({
  checkId: GCP_EXPIRING_CERTS,
  resourceType: CERT_TYPE,
  readFacts: (certificate, fields, settings) => ({
    threshold: settings.certExpiryFlagDays,
    certificateId: nonEmptyStr(fields, "certificateId") ?? certificate.displayName,
    expireTime: str(fields, "expireTime"),
    daysRemaining: num(fields, "daysRemaining")
  }),
  decide: ({ threshold, certificateId, expireTime, daysRemaining }, { resource }) => {
    const evidence = {
      resourceUri: resource.resourceUri,
      certificateId,
      expireTime,
      daysRemaining,
      flagDays: threshold
    };
    if (!(threshold > 0)) {
      return undetermined("Set certificate expiry warning days in Settings", {
        ...evidence,
        daysRemaining: null,
        flagDays: null
      });
    }
    if (daysRemaining === null) {
      return undetermined("A Certificate Manager read that includes expireTime", evidence);
    }
    return daysRemaining <= threshold ? fail(evidence) : pass(evidence);
  }
});

// backend/src/gcp-recommender.ts
var GCP_IDLE_RECS = "gcp-waste-idle-vm-and-disk-recommendations";
var REC_TYPE = "recommender.googleapis.com/Recommendation";
var RECOMMENDER_SAVINGS_BASIS = "Recommender savings range when present; otherwise undetermined, not a point value";
var EMPTY_RECOMMENDER_WORDING = "None were returned. Idle status is unknown.";
var RECOMMENDER_ROLE_CLOSER = "Grant Recommender Viewer and a recommendation list for that project";
var RECOMMENDER_RANGE_CLOSER = "A recommendation primaryImpact with a min/max cost range";
function acceptFinding3(finding) {
  assertValid(validateFinding(finding));
  return finding;
}
function scope3(projectId) {
  return {
    id: `${projectId}:${GCP_IDLE_RECS}`,
    cloud: "gcp",
    subscriptionOrProject: projectId
  };
}
function recommenderSavings(min, max, currency) {
  return savingsRange({ min, max, currency, basis: RECOMMENDER_SAVINGS_BASIS });
}
function checkGcpIdleRecommendations(projectId, harvest) {
  if (!harvest.ok) {
    return {
      findings: [
        acceptFinding3({
          checkId: GCP_IDLE_RECS,
          result: "undetermined",
          closer: RECOMMENDER_ROLE_CLOSER,
          evidence: {
            fields: {
              recommendationId: null,
              recommenderId: null,
              resourceName: null,
              subtype: null,
              missingRole: "Recommender Viewer"
            }
          },
          scope: scope3(projectId)
        })
      ],
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: projectId,
          checkId: GCP_IDLE_RECS,
          state: "unassessed",
          causeId: "missing_role",
          closer: RECOMMENDER_ROLE_CLOSER
        })
      ]
    };
  }
  if (harvest.recommendations.length === 0) {
    return {
      findings: [
        acceptFinding3({
          checkId: GCP_IDLE_RECS,
          result: "pass",
          evidence: {
            fields: {
              noneFound: true,
              recommendationCount: 0,
              emptyResult: EMPTY_RECOMMENDER_WORDING
            }
          },
          scope: scope3(projectId)
        })
      ],
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: projectId,
          checkId: GCP_IDLE_RECS,
          state: "assessed"
        })
      ]
    };
  }
  const findings = harvest.recommendations.map((row) => {
    const evidence = {
      resourceUri: row.resourceName,
      recommendationId: row.recommendationId,
      recommenderId: row.recommenderId,
      resourceName: row.resourceName,
      subtype: row.subtype
    };
    if (typeof row.savingsMin !== "number" || typeof row.savingsMax !== "number") {
      return acceptFinding3({
        checkId: GCP_IDLE_RECS,
        result: "undetermined",
        closer: RECOMMENDER_RANGE_CLOSER,
        evidence: { fields: { ...evidence, savingsMin: null, savingsMax: null } },
        scope: scope3(projectId)
      });
    }
    try {
      const savings = recommenderSavings(row.savingsMin, row.savingsMax, row.currency ?? "USD");
      return acceptFinding3({
        checkId: GCP_IDLE_RECS,
        result: "fail",
        evidence: { fields: { ...evidence, savingsBasis: savings.basis } },
        scope: scope3(projectId),
        savings: { min: savings.min, max: savings.max, currency: savings.currency }
      });
    } catch (error) {
      if (error instanceof PointSavingsError) {
        return acceptFinding3({
          checkId: GCP_IDLE_RECS,
          result: "undetermined",
          closer: RECOMMENDER_RANGE_CLOSER,
          evidence: { fields: { ...evidence, savingsMin: row.savingsMin, savingsMax: row.savingsMax } },
          scope: scope3(projectId)
        });
      }
      throw error;
    }
  });
  return {
    findings,
    coverage: [
      recordCoverageScope({
        subscriptionOrProject: projectId,
        checkId: GCP_IDLE_RECS,
        state: "assessed"
      })
    ]
  };
}
function harvestRecommendations(inventory, facts) {
  const rows = indexFacts(facts);
  const byProject = /* @__PURE__ */ new Map();
  for (const resource of inventory.resources) {
    const project = projectOf(resource.resourceUri);
    if (!byProject.has(project)) {
      byProject.set(project, []);
    }
    if (resource.resourceType !== REC_TYPE) {
      continue;
    }
    const fields = rows.get(resource.resourceUri)?.fields;
    const projectId = nonEmptyStr(fields, "projectId") ?? project;
    const list = byProject.get(projectId) ?? [];
    const savingsMin = num(fields, "savingsMin");
    const savingsMax = num(fields, "savingsMax");
    const currency = str(fields, "currency");
    list.push({
      recommendationId: nonEmptyStr(fields, "recommendationId") ?? resource.displayName,
      recommenderId: nonEmptyStr(fields, "recommenderId") ?? "",
      resourceName: nonEmptyStr(fields, "resourceName") ?? resource.resourceUri,
      subtype: nonEmptyStr(fields, "subtype") ?? "",
      projectId,
      ...savingsMin === null ? {} : { savingsMin },
      ...savingsMax === null ? {} : { savingsMax },
      ...currency ? { currency } : {}
    });
    byProject.set(projectId, list);
  }
  return byProject;
}
var checkGcpIdleRecs = checkDefinition({ checkId: GCP_IDLE_RECS, cloud: "gcp" }, (inventory, facts) => {
  const findings = [];
  for (const [projectId, recommendations] of harvestRecommendations(inventory, facts)) {
    findings.push(...checkGcpIdleRecommendations(projectId, { ok: true, recommendations }).findings);
  }
  return findings;
});

// docs/gcp/support-versions.json
var support_versions_default = {
  version: 1,
  publishedAt: "2026-11-03",
  source: "docs/gcp/support-versions.json",
  note: "In-repo Farside-test support calendar. Not a live Google announcement. Refresh by editing this file.",
  entries: [
    {
      kind: "sql",
      version: "MYSQL_5_6",
      supportEnd: "2021-02-01",
      source: "docs/gcp/support-versions.json#MYSQL_5_6"
    },
    {
      kind: "gke",
      version: "1.24",
      supportEnd: "2024-01-31",
      source: "docs/gcp/support-versions.json#gke-1.24"
    }
  ]
};

// backend/src/gcp-support.ts
var GCP_SQL_GKE_SUPPORT = "gcp-lifecycle-sql-gke-support";
var SQL_TYPE = "sqladmin.googleapis.com/Instance";
var GKE_TYPE = "container.googleapis.com/Cluster";
function loadSupportVersions() {
  return support_versions_default;
}
var VERSION_FIELD = { sql: "databaseVersion", gke: "currentMasterVersion" };
var checkGcpSqlGkeSupport = defineGcpCheck({
  checkId: GCP_SQL_GKE_SUPPORT,
  resourceType: [SQL_TYPE, GKE_TYPE],
  prepare: () => {
    const catalogue = loadSupportVersions();
    return { catalogue, byKey: new Map(catalogue.entries.map((entry) => [`${entry.kind}:${entry.version}`, entry])) };
  },
  readFacts: (resource, fields) => {
    const kind = resource.resourceType === SQL_TYPE ? "sql" : "gke";
    return { kind, version: nonEmptyStr(fields, VERSION_FIELD[kind]) };
  },
  decide: ({ kind, version }, { resource, shared: { catalogue, byKey } }) => {
    const identity = {
      resourceUri: resource.resourceUri,
      resourceName: resource.resourceUri.split("/").pop() ?? resource.displayName,
      resourceKind: kind
    };
    if (version === null) {
      return undetermined("An instance or cluster read that includes the engine version", {
        ...identity,
        version: null,
        supportEnd: null
      });
    }
    const listed = byKey.get(`${kind}:${version}`);
    if (listed && listed.supportEnd <= catalogue.publishedAt) {
      return fail({ ...identity, version, supportEnd: listed.supportEnd, source: listed.source });
    }
    return pass({
      ...identity,
      version,
      supportEnd: listed?.supportEnd ?? null,
      source: catalogue.source,
      cataloguePublishedAt: catalogue.publishedAt
    });
  }
});

// backend/src/gcp-resilience.ts
var GCP_SQL_HA_OR_BACKUP = "gcp-resilience-sql-ha-or-backup";
var SQL_HA_TYPE = "REGIONAL";
var checkGcpSqlHaOrBackup = defineGcpCheck({
  checkId: GCP_SQL_HA_OR_BACKUP,
  resourceType: SQL_TYPE,
  readFacts: (instance, fields) => ({
    instanceName: nonEmptyStr(fields, "instanceName") ?? instance.displayName,
    availabilityType: str(fields, "availabilityType"),
    backupEnabled: bool(fields, "backupEnabled"),
    projectId: nonEmptyStr(fields, "projectId") ?? projectOf(instance.resourceUri)
  }),
  decide: ({ instanceName, availabilityType, backupEnabled, projectId }, { resource }) => {
    const evidence = {
      resourceUri: resource.resourceUri,
      instanceName,
      availabilityType,
      backupEnabled,
      projectId
    };
    if (availabilityType === null || backupEnabled === null) {
      return undetermined("A Cloud SQL instance read that includes both fields", evidence);
    }
    return availabilityType === SQL_HA_TYPE && backupEnabled ? pass(evidence) : fail(evidence);
  }
});

// docs/gcp/ground-truth.json
var ground_truth_default2 = {
  version: 1,
  story: "E6-S2",
  cloud: "gcp",
  ownerLabelKey: "owner",
  snapshotRetentionDays: 30,
  provisioned: false,
  provisionedNote: "Physical GCP project and Cloud Asset harvest are leftovers (D7, #196, #197). This file is the repeatable seed. Invented names only. No customer data.",
  projects: [
    {
      id: "farside-test",
      role: "seeded-waste"
    }
  ],
  items: [
    {
      id: "disk-parked",
      project: "farside-test",
      type: "compute.googleapis.com/Disk",
      title: "Unattached persistent disk",
      region: "us-central1-a",
      properties: { usersCount: 0, sizeGb: 100 },
      labels: {}
    },
    {
      id: "disk-in-use",
      project: "farside-test",
      type: "compute.googleapis.com/Disk",
      title: "Disk attached to vm-harbor",
      region: "us-central1-a",
      properties: { usersCount: 1, sizeGb: 50 },
      labels: { owner: "farside-test" }
    },
    {
      id: "addr-idle",
      project: "farside-test",
      type: "compute.googleapis.com/Address",
      title: "Reserved unused external IP",
      region: "us-central1",
      properties: { status: "RESERVED", usersCount: 0, address: "203.0.113.10" },
      labels: { owner: "farside-test" }
    },
    {
      id: "addr-bound",
      project: "farside-test",
      type: "compute.googleapis.com/Address",
      title: "External IP in use",
      region: "us-central1",
      properties: { status: "IN_USE", usersCount: 1, address: "203.0.113.11" },
      labels: { owner: "farside-test" }
    },
    {
      id: "snap-aged",
      project: "farside-test",
      type: "compute.googleapis.com/Snapshot",
      title: "Snapshot older than retention",
      region: "global",
      properties: { ageDays: 90, sizeGb: 20 },
      labels: { owner: "farside-test" }
    },
    {
      id: "snap-fresh",
      project: "farside-test",
      type: "compute.googleapis.com/Snapshot",
      title: "Snapshot inside retention",
      region: "global",
      properties: { ageDays: 5, sizeGb: 20 },
      labels: { owner: "farside-test" }
    },
    {
      id: "image-stale",
      project: "farside-test",
      type: "compute.googleapis.com/Image",
      title: "Custom image older than retention",
      region: "global",
      properties: { ageDays: 120, sizeGb: 10 },
      labels: { owner: "farside-test" }
    },
    {
      id: "image-current",
      project: "farside-test",
      type: "compute.googleapis.com/Image",
      title: "Custom image inside retention",
      region: "global",
      properties: { ageDays: 4, sizeGb: 10 },
      labels: { owner: "farside-test" }
    },
    {
      id: "vm-harbor",
      project: "farside-test",
      type: "compute.googleapis.com/Instance",
      title: "Busy VM used as a live-looking negative",
      region: "us-central1-a",
      properties: { status: "RUNNING" },
      labels: { owner: "farside-test" }
    },
    {
      id: "sql-stale",
      project: "farside-test",
      type: "sqladmin.googleapis.com/Instance",
      title: "Cloud SQL on an out-of-support version",
      region: "us-central1",
      properties: { databaseVersion: "MYSQL_5_6", availabilityType: "REGIONAL", backupEnabled: true },
      labels: { owner: "farside-test" }
    },
    {
      id: "sql-current",
      project: "farside-test",
      type: "sqladmin.googleapis.com/Instance",
      title: "Cloud SQL on a version not listed as ended",
      region: "us-central1",
      properties: { databaseVersion: "MYSQL_8_0", availabilityType: "REGIONAL", backupEnabled: true },
      labels: { owner: "farside-test" }
    },
    {
      id: "sql-zonal",
      project: "farside-test",
      type: "sqladmin.googleapis.com/Instance",
      title: "Cloud SQL without regional high availability",
      region: "us-central1",
      properties: { databaseVersion: "MYSQL_8_0", availabilityType: "ZONAL", backupEnabled: true },
      labels: { owner: "farside-test" }
    },
    {
      id: "sql-no-backup",
      project: "farside-test",
      type: "sqladmin.googleapis.com/Instance",
      title: "Cloud SQL without automated backups",
      region: "us-central1",
      properties: { databaseVersion: "MYSQL_8_0", availabilityType: "REGIONAL", backupEnabled: false },
      labels: { owner: "farside-test" }
    },
    {
      id: "gke-stale",
      project: "farside-test",
      type: "container.googleapis.com/Cluster",
      title: "GKE cluster on an out-of-support version",
      region: "us-central1",
      properties: { currentMasterVersion: "1.24" },
      labels: { owner: "farside-test" }
    },
    {
      id: "gke-current",
      project: "farside-test",
      type: "container.googleapis.com/Cluster",
      title: "GKE cluster on a version not listed as ended",
      region: "us-central1",
      properties: { currentMasterVersion: "1.30" },
      labels: { owner: "farside-test" }
    },
    {
      id: "cert-expiring",
      project: "farside-test",
      type: "certificatemanager.googleapis.com/Certificate",
      title: "Certificate inside the expiry warning window",
      region: "global",
      properties: { expireTime: "2026-11-20T00:00:00Z", daysRemaining: 36 },
      labels: { owner: "farside-test" }
    },
    {
      id: "cert-current",
      project: "farside-test",
      type: "certificatemanager.googleapis.com/Certificate",
      title: "Certificate outside the expiry warning window",
      region: "global",
      properties: { expireTime: "2027-10-15T00:00:00Z", daysRemaining: 365 },
      labels: { owner: "farside-test" }
    },
    {
      id: "rec-vm-parked",
      project: "farside-test",
      type: "recommender.googleapis.com/Recommendation",
      title: "Idle VM recommendation",
      region: "us-central1-a",
      properties: {
        recommenderId: "google.compute.instance.IdleResourceRecommender",
        resourceName: "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/instances/vm-parked",
        subtype: "IDLE_VM",
        savingsMin: 20,
        savingsMax: 32,
        currency: "USD"
      },
      labels: { owner: "farside-test" }
    },
    {
      id: "rec-disk-idle",
      project: "farside-test",
      type: "recommender.googleapis.com/Recommendation",
      title: "Idle disk recommendation",
      region: "us-central1-a",
      properties: {
        recommenderId: "google.compute.disk.IdleResourceRecommender",
        resourceName: "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/disks/disk-parked",
        subtype: "IDLE_DISK",
        savingsMin: 8,
        savingsMax: 12,
        currency: "USD"
      },
      labels: { owner: "farside-test" }
    }
  ]
};

// backend/src/providers/gcp.ts
var gcpProvider = {
  cloud: "gcp",
  launchCheckIds: GCP_LAUNCH_CHECK_IDS,
  harvestAssessedCheckIds: GCP_HARVEST_ASSESSED_CHECK_IDS,
  // From docs/gcp/launch-checks.json. Not yet verified against a live project (#192).
  requiredRoles: [
    "Cloud Asset Viewer",
    "Compute Viewer",
    "Recommender Viewer",
    "Cloud SQL Viewer",
    "Certificate Manager Viewer"
  ],
  optionalRoles: ["BigQuery access to the billing export"],
  scopeOf: projectOf,
  harvester: (clock) => {
    const manifest = ground_truth_default2;
    return fixtureHarvester(inventoryFromGcpManifest(manifest), factsFromGcpManifest(manifest), clock);
  },
  checks: [
    checkGcpUnattachedDisks,
    checkGcpUnusedIps,
    checkGcpOldSnapshotsAndImages,
    checkGcpIdleRecs,
    checkGcpCud,
    checkGcpSqlHaOrBackup,
    checkGcpSqlGkeSupport,
    checkGcpExpiringCerts
  ]
};

// backend/src/providers/index.ts
registerProvider(azureProvider);
registerProvider(gcpProvider);

// backend/src/cli-credentials.ts
var TOKEN_FLAG_MESSAGE = "credentials must come from Azure CLI / DefaultAzureCredential or GCP Application Default Credentials; token flags are refused";
var TOKEN_FLAG_NAMES = /* @__PURE__ */ new Set([
  "token",
  "access-token",
  "accesstoken",
  "refresh-token",
  "client-secret",
  "client_secret",
  "password"
]);
var SPECS = {
  azure: launch_checks_default,
  gcp: launch_checks_default2
};
function isTokenFlag(name) {
  const normalized = name.replace(/_/g, "-").toLowerCase();
  return TOKEN_FLAG_NAMES.has(normalized);
}
function checksForRole(cloud, role) {
  return SPECS[cloud].checks.filter((check) => check.role === role).map((check) => check.id);
}
function specRoles(cloud) {
  const roles = [];
  const seen = /* @__PURE__ */ new Set();
  for (const check of SPECS[cloud].checks) {
    if (seen.has(check.role)) {
      continue;
    }
    seen.add(check.role);
    roles.push(check.role);
  }
  return roles;
}
function missingRoles(cloud, granted) {
  const have = new Set(granted);
  const provider = providerFor(cloud);
  const optional = new Set(provider.optionalRoles);
  const fromProvider = [
    ...provider.requiredRoles.filter((role) => !have.has(role)).map((role) => ({ role, required: true, blockedCheckIds: checksForRole(cloud, role) })),
    ...provider.optionalRoles.filter((role) => !have.has(role)).map((role) => ({ role, required: false, blockedCheckIds: checksForRole(cloud, role) }))
  ];
  if (fromProvider.length > 0) {
    return fromProvider;
  }
  return specRoles(cloud).filter((role) => !have.has(role)).map((role) => ({
    role,
    required: !optional.has(role),
    blockedCheckIds: checksForRole(cloud, role)
  }));
}
function probeLocalCredentials(cloud, env = process.env, home = env.HOME ?? homedir()) {
  if (cloud === "gcp") {
    const adc = env.GOOGLE_APPLICATION_CREDENTIALS;
    const path = typeof adc === "string" && adc.length > 0 ? adc : join(home, ".config/gcloud/application_default_credentials.json");
    return existsSync(path) ? { present: true, source: "gcp-adc" } : {
      present: false,
      source: "gcp-adc",
      error: "GCP Application Default Credentials are required"
    };
  }
  if (typeof env.AZURE_CLIENT_SECRET === "string" && env.AZURE_CLIENT_SECRET.length > 0) {
    return {
      present: false,
      source: "none",
      error: "client secrets are refused; use Azure CLI or federated DefaultAzureCredential"
    };
  }
  if (existsSync(join(home, ".azure"))) {
    return { present: true, source: "azure-cli" };
  }
  if (typeof env.AZURE_CLIENT_ID === "string" && env.AZURE_CLIENT_ID.length > 0) {
    return { present: true, source: "azure-adc" };
  }
  return {
    present: false,
    source: "none",
    error: "signed-in Azure CLI or DefaultAzureCredential is required"
  };
}

// backend/src/checks.ts
var UnregisteredCheckError = class extends Error {
  constructor(checkId) {
    super(`unregistered check '${checkId}' cannot run`);
    this.name = "UnregisteredCheckError";
  }
};
function runChecks(input) {
  const { inventory, facts } = input;
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const rows = indexFacts(facts);
  const findings = [];
  const coverage = [];
  const scopes = [
    .../* @__PURE__ */ new Set([
      ...inventory.resources.map((resource) => scopeOf(inventory.cloud, resource.resourceUri)),
      ...input.scopes ?? []
    ])
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
      const undetermined2 = scoped.length > 0 && !determinate;
      coverage.push(
        recordCoverageScope({
          subscriptionOrProject,
          checkId,
          state: undetermined2 ? "undetermined" : "assessed",
          ...undetermined2 && closer ? { closer } : {}
        })
      );
    }
    for (const unread of input.unreadSubscriptions ?? []) {
      coverage.push(
        recordCoverageScope({
          subscriptionOrProject: unread,
          checkId,
          state: "unassessed",
          causeId: "failed_call"
        })
      );
    }
  }
  return { findings, coverage };
}

// backend/src/scans.ts
import { randomUUID } from "node:crypto";

// backend/src/observability.ts
var silentLog = {
  info: () => void 0,
  error: () => void 0
};

// backend/src/cost-total.ts
var MIXED_CURRENCY_CLOSER = CURRENCY_CLOSER;
var COST_CHECK_IDS = [SPEND_BY_SERVICE, MONTH_ON_MONTH];
function hasFigures(snapshot) {
  return snapshot.currency.length > 0 && snapshot.services.length + snapshot.months.length > 0;
}
function hasMixedCurrencies(snapshots) {
  return new Set(
    snapshots.filter(hasFigures).flatMap((snapshot) => [
      snapshot.currency,
      ...snapshot.services.map((figure2) => figure2.currency),
      ...snapshot.months.map((figure2) => figure2.currency)
    ])
  ).size > 1;
}
function monthOf(figure2) {
  return figure2.periodStart.slice(0, 7);
}
function sumMonthly(figures, scopes) {
  const groups = /* @__PURE__ */ new Map();
  for (const figure2 of figures) {
    const key = `${figure2.serviceName}|${monthOf(figure2)}`;
    const group = groups.get(key);
    if (group) {
      group.push(figure2);
    } else {
      groups.set(key, [figure2]);
    }
  }
  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    if (!first) {
      return [];
    }
    return [
      {
        ...first,
        billingScope: scopes,
        agreementType: new Set(group.map((item) => item.agreementType)).size > 1 ? "mixed" : first.agreementType,
        periodEnd: group.map((item) => item.periodEnd).sort().at(-1) ?? first.periodEnd,
        costAmount: addAmounts(group.map((item) => item.costAmount)),
        provisional: group.some((item) => item.provisional)
      }
    ];
  }).sort(
    (left, right) => left.periodStart.localeCompare(right.periodStart) || left.serviceName.localeCompare(right.serviceName)
  );
}
function combineCosts(snapshots) {
  const usable = snapshots.filter(hasFigures);
  const first = usable[0];
  if (!first || hasMixedCurrencies(usable)) {
    return null;
  }
  if (usable.length === 1) {
    return first;
  }
  const scopes = [...new Set(usable.map((snapshot) => snapshot.billingScope))].join(",");
  const agreementType = new Set(usable.map((snapshot) => snapshot.agreementType)).size > 1 ? "mixed" : first.agreementType;
  const months = sumMonthly(
    usable.flatMap((snapshot) => snapshot.months),
    scopes
  );
  const services = sumMonthly(
    usable.flatMap((snapshot) => snapshot.services),
    scopes
  );
  const serviceMonths = sumMonthly(
    usable.flatMap((snapshot) => snapshot.serviceMonths),
    scopes
  );
  const provisional = usable.flatMap((snapshot) => snapshot.provisionalDate ? [snapshot.provisionalDate] : []);
  return {
    ...first,
    subscriptionId: usable.map((snapshot) => snapshot.subscriptionId).join(","),
    billingScope: scopes,
    agreementType,
    periodStart: months[0]?.periodStart ?? first.periodStart,
    periodEnd: months.at(-1)?.periodEnd ?? first.periodEnd,
    asOf: usable.map((snapshot) => snapshot.asOf).sort().at(-1) ?? first.asOf,
    provisionalDate: provisional.sort().at(-1) ?? null,
    services,
    months,
    serviceMonths,
    monthOnMonth: monthOnMonth(serviceMonths, agreementType)
  };
}
function markMixedCurrency(coverage, subscriptionIds) {
  if (subscriptionIds.length === 0) {
    return coverage;
  }
  return applyCoverageResults(
    coverage,
    subscriptionIds.flatMap(
      (subscriptionOrProject) => COST_CHECK_IDS.map((checkId) => ({
        subscriptionOrProject,
        checkId,
        state: "undetermined",
        closer: MIXED_CURRENCY_CLOSER
      }))
    )
  );
}
function restoreAfterMixedCurrency(coverage, snapshots) {
  const restored = coverage.filter(
    (entry) => COST_CHECK_IDS.includes(entry.checkId) && entry.state === "undetermined" && entry.closer === MIXED_CURRENCY_CLOSER && snapshots[entry.subscriptionOrProject] !== void 0
  ).map((entry) => {
    const hasChange = (snapshots[entry.subscriptionOrProject]?.monthOnMonth.length ?? 0) > 0;
    const unresolved = entry.checkId === MONTH_ON_MONTH && !hasChange;
    return {
      subscriptionOrProject: entry.subscriptionOrProject,
      checkId: entry.checkId,
      state: unresolved ? "undetermined" : "assessed",
      ...unresolved ? { closer: TWO_MONTHS_CLOSER } : {}
    };
  });
  return restored.length > 0 ? applyCoverageResults(coverage, restored) : coverage;
}

// backend/src/demo.ts
var DEMO_ORG_ID = "demo";

// backend/src/billing.ts
var WARNING_DAYS = 7;
var GRACE_DAYS = 14;
var RETAIN_DAYS = 30;
var DAY_MS2 = 864e5;
var PAUSE_AFTER_DAYS = WARNING_DAYS + GRACE_DAYS;
var OFFBOARD_AFTER_DAYS = PAUSE_AFTER_DAYS + RETAIN_DAYS;
function addDays(iso, days) {
  return new Date(Date.parse(iso) + days * DAY_MS2).toISOString();
}
function retainUntil(contract) {
  const ended = contract.endDate ?? (contract.state === "ended" ? contract.stateChangedAt : null);
  const deadlines = [
    ended ? addDays(ended, RETAIN_DAYS) : null,
    contract.unpaidAt ? addDays(contract.unpaidAt, OFFBOARD_AFTER_DAYS) : null
  ].filter((value) => value !== null);
  return deadlines.length === 0 ? null : deadlines.reduce((earliest, next) => Date.parse(next) < Date.parse(earliest) ? next : earliest);
}
function retentionElapsed(contract, now) {
  const until = retainUntil(contract);
  return until !== null && Date.parse(now) >= Date.parse(until);
}

// backend/src/offboard.ts
var GRANTS_TO_REMOVE = [
  ...allProviders().flatMap(({ cloud, requiredRoles, optionalRoles }) => [
    ...requiredRoles.map((name) => ({ kind: `${cloud}-role`, name })),
    ...optionalRoles.map((name) => ({ kind: `${cloud}-role`, name, optional: true }))
  ]),
  {
    kind: "admin-consent",
    name: "Farside multi-tenant app registration"
  }
];
var DeletedOrgError = class extends Error {
  constructor(orgId) {
    super(`org ${orgId} has been deleted`);
    this.name = "DeletedOrgError";
  }
};

// backend/src/repository.ts
var MAX_SCANS_PER_ORG = 200;
var SUBSCRIPTION_DISCONNECTED = "subscription disconnected";

// backend/src/scheduler.ts
var RETRY_DELAY_HOURS = 1;
var DEFAULT_SCAN_TIMEOUT_MS = 6e5;
function emptySchedule() {
  return { nextRunAt: null, lastTickAt: null, retryCount: 0, retryCounts: {}, regularRunAt: null, retryAt: null, records: [] };
}
function addHours(iso, hours) {
  return new Date(Date.parse(iso) + hours * 36e5).toISOString();
}

// backend/src/secrets.ts
var SECRET_KEY_PARTS = [
  "secret",
  "token",
  "password",
  "privatekey",
  "apikey",
  "authorization",
  "connectionstring",
  "accountkey"
];
var SECRET_VALUE = new RegExp(
  [
    "client_secret",
    "azure[_-]?client[_-]?secret",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "ya29\\.[A-Za-z0-9_-]{20,}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "[?&]sig=[A-Za-z0-9%+/=]{20,}",
    "(?<![A-Za-z0-9])[A-Za-z0-9_.~-]{3}\\dQ~[A-Za-z0-9_.~-]{31,256}"
  ].join("|"),
  "i"
);
var SAS_KEY = /^sas(token|url|uri|key|signature)|sas$/;
var NON_SECRET_NUMBER_SUFFIXES = ["count", "total", "days", "hours", "limit"];
function hasJwt(value) {
  const segments = value.split(/[^A-Za-z0-9_.-]+/).flatMap((token) => token.split("."));
  return segments.some((segment, index) => {
    const start = segment.indexOf("eyJ");
    return start >= 0 && segment.length - start >= 23 && (segments[index + 1]?.length ?? 0) >= 10;
  });
}
function isSecretKey(key, child) {
  if (child == null || typeof child === "boolean") {
    return false;
  }
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  if (typeof child === "number" && NON_SECRET_NUMBER_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return false;
  }
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part)) || SAS_KEY.test(normalized);
}
var SecretLeakError = class extends Error {
  constructor(path) {
    super(`secret or token pattern at ${path}`);
    this.name = "SecretLeakError";
  }
};
function walk(value, path, hits, inTags = false) {
  if (value == null) {
    return;
  }
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value) || hasJwt(value)) {
      hits.push(path);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!(inTags && typeof child === "string") && isSecretKey(key, child)) {
      hits.push(childPath);
    }
    walk(child, childPath, hits, key.toLowerCase() === "tags");
  }
}
function secretPaths(value) {
  const hits = [];
  walk(value, "", hits);
  return hits;
}
function assertNoSecrets(value) {
  const hits = secretPaths(value);
  if (hits.length > 0) {
    throw new SecretLeakError(hits[0] ?? "");
  }
}
var verified = /* @__PURE__ */ new WeakSet();
function markVerified(value) {
  verified.add(value);
  return value;
}
function markVerifiedAll(values) {
  verified.add(values);
  for (const value of values) {
    verified.add(value);
  }
  return values;
}

// backend/src/org-ops.ts
function emptyOrg(now) {
  return {
    connections: [],
    inventory: null,
    inventories: {},
    coverage: [],
    findings: [],
    settings: { ...DEFAULT_SETTINGS, updatedAt: now },
    scans: [],
    facts: [],
    issues: [],
    cost: null,
    costs: {},
    commitments: null,
    commitmentsBySubscription: {},
    budgets: null,
    alerts: null,
    schedule: emptySchedule(),
    contract: null,
    sequences: { scan: 0, schedule: 0, connection: 0 }
  };
}
function combineCommitments(snapshots) {
  const first = snapshots[0];
  if (!first || snapshots.length === 1) {
    return first ?? null;
  }
  return {
    ...first,
    subscriptionId: snapshots.map((item) => item.subscriptionId).join(","),
    billingScope: [...new Set(snapshots.map((item) => item.billingScope))].join(","),
    periodStart: snapshots.map((item) => item.periodStart).sort()[0] ?? first.periodStart,
    periodEnd: snapshots.map((item) => item.periodEnd).sort().at(-1) ?? first.periodEnd,
    reservations: snapshots.flatMap((item) => item.reservations),
    savingsPlans: snapshots.flatMap((item) => item.savingsPlans),
    noneFound: {
      reservations: snapshots.every((item) => item.noneFound.reservations),
      savingsPlans: snapshots.every((item) => item.noneFound.savingsPlans)
    }
  };
}
function pruneScans(scans) {
  const current = [...scans].reverse().find((job) => job.status === "succeeded" && job.complete);
  let excess = scans.length - MAX_SCANS_PER_ORG;
  return scans.filter((job) => {
    const settled = job.status !== "queued" && job.status !== "running" && job !== current;
    if (excess > 0 && settled) {
      excess -= 1;
      return false;
    }
    return true;
  });
}
function refreshCost(org) {
  const snapshots = Object.values(org.costs);
  org.cost = combineCosts(snapshots);
  org.coverage = hasMixedCurrencies(snapshots) ? markMixedCurrency(
    org.coverage,
    Object.keys(org.costs).filter((key) => org.costs[key] && hasFigures(org.costs[key]))
  ) : restoreAfterMixedCurrency(org.coverage, org.costs);
}
function applyCoverage(org, coverage) {
  org.coverage = coverage;
  refreshCost(org);
}
function applyCost(org, cost, subscriptionId) {
  if (subscriptionId === void 0) {
    org.costs = {};
  } else {
    delete org.costs[subscriptionId];
    if (cost) {
      org.costs[subscriptionId] = cost;
    }
  }
  refreshCost(org);
}
function applyCommitments(org, commitments, subscriptionId) {
  if (subscriptionId === void 0) {
    org.commitmentsBySubscription = {};
  } else {
    delete org.commitmentsBySubscription[subscriptionId];
    if (commitments) {
      org.commitmentsBySubscription[subscriptionId] = commitments;
    }
  }
  org.commitments = combineCommitments(Object.values(org.commitmentsBySubscription));
}
function retagInventories(org, ownerTagKey) {
  for (const cloud of CLOUDS) {
    const inventory = org.inventories[cloud];
    if (inventory) {
      org.inventories[cloud] = markVerified(applyOwnerTag(inventory, ownerTagKey));
    }
  }
  if (org.inventory) {
    org.inventory = markVerified(applyOwnerTag(org.inventory, ownerTagKey));
  }
}
function dropSubscription(org, subscriptionId) {
  const target = subscriptionId.toLowerCase();
  const inScope = (cloud, resourceUri) => scopeOf(cloud, resourceUri).toLowerCase() === target;
  for (const cloud of CLOUDS) {
    const inventory = org.inventories[cloud];
    if (inventory) {
      org.inventories[cloud] = markVerified({
        ...inventory,
        resources: inventory.resources.filter((resource) => !inScope(cloud, resource.resourceUri))
      });
    }
  }
  const latest = org.inventory;
  if (latest) {
    org.inventory = markVerified({
      ...latest,
      resources: latest.resources.filter((resource) => !inScope(latest.cloud, resource.resourceUri))
    });
  }
  org.facts = org.facts.filter((row) => !CLOUDS.some((cloud) => inScope(cloud, row.resourceUri)));
  for (const key of Object.keys(org.costs)) {
    if (key.toLowerCase() === target) {
      delete org.costs[key];
    }
  }
  for (const key of Object.keys(org.commitmentsBySubscription)) {
    if (key.toLowerCase() === target) {
      delete org.commitmentsBySubscription[key];
    }
  }
  org.commitments = combineCommitments(Object.values(org.commitmentsBySubscription));
  const matches = (value) => value.toLowerCase() === target;
  org.findings = org.findings.filter((finding) => !matches(finding.scope.subscriptionOrProject));
  org.coverage = org.coverage.filter((entry) => !matches(entry.subscriptionOrProject));
  org.issues = org.issues.map((issue) => {
    if (!matches(issue.subscriptionOrProject) || issue.status === "closed") {
      return issue;
    }
    const { closingScanId: _closing, notConfirmedReason: _reason, ...rest } = issue;
    return { ...rest, status: "closed", closedReason: SUBSCRIPTION_DISCONNECTED };
  });
  markVerifiedAll(org.issues);
  refreshCost(org);
}
function rowsPurged(org) {
  const inventories = [
    ...Object.values(org?.inventories ?? {}),
    ...org?.inventory && !org.inventories[org.inventory.cloud] ? [org.inventory] : []
  ];
  return {
    connections: org?.connections.length ?? 0,
    inventoryResources: inventories.reduce((sum, inventory) => sum + inventory.resources.length, 0),
    facts: org?.facts.length ?? 0,
    findings: org?.findings.length ?? 0,
    coverage: org?.coverage.length ?? 0,
    issues: org?.issues.length ?? 0,
    scans: org?.scans.length ?? 0,
    costSnapshots: Object.keys(org?.costs ?? {}).length,
    commitments: Object.keys(org?.commitmentsBySubscription ?? {}).length,
    budgets: org?.budgets ? 1 : 0,
    alerts: org?.alerts ? 1 : 0,
    settings: org ? 1 : 0,
    contract: org?.contract ? 1 : 0
  };
}
function deletionRecordFor(org, input) {
  const schedulePending = Boolean(org && org.settings.scanScheduleEnabled && org.schedule.nextRunAt);
  return {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    deletedAt: input.now,
    rowsPurged: rowsPurged(org),
    connectionsRemoved: org?.connections.length ?? 0,
    scansStopped: input.runningScans + (org?.scans.filter((job) => job.status === "queued").length ?? 0),
    scheduleCancelled: schedulePending || Boolean(org?.settings.scanScheduleEnabled),
    accountClosureAt: null,
    trigger: input.trigger
  };
}
var RunningScans = class {
  #running = /* @__PURE__ */ new Map();
  track(orgId) {
    const controller = new AbortController();
    const controllers = this.#running.get(orgId) ?? /* @__PURE__ */ new Set();
    controllers.add(controller);
    this.#running.set(orgId, controllers);
    return {
      signal: controller.signal,
      release: () => {
        controllers.delete(controller);
        if (controllers.size === 0 && this.#running.get(orgId) === controllers) {
          this.#running.delete(orgId);
        }
      }
    };
  }
  abortAll(orgId) {
    const running = this.#running.get(orgId) ?? /* @__PURE__ */ new Set();
    for (const controller of running) {
      controller.abort();
    }
    this.#running.delete(orgId);
    return running.size;
  }
};
async function sweepRetention(repository, now, onlyOrgId, log = silentLog) {
  const candidates = onlyOrgId === void 0 ? await repository.orgIds() : await repository.hasOrg(onlyOrgId) ? [onlyOrgId] : [];
  const records = [];
  for (const orgId of candidates.filter((id) => id !== DEMO_ORG_ID)) {
    try {
      const { contract } = await repository.read(orgId, "contract");
      if (contract !== null && retentionElapsed(asMutable(contract), now)) {
        records.push(await repository.offboard(orgId, now, "retention"));
      }
    } catch (error) {
      if (!(error instanceof DeletedOrgError)) {
        log.error({ err: error, orgId }, "retention sweep skipped an org");
      }
    }
  }
  return records;
}

// backend/src/scans.ts
var EMPTY_COVERAGE_SUMMARY = {
  assessed: 0,
  unassessed: 0,
  undetermined: 0
};
var FAILED_BEFORE_CHECK = "Scan failed before this check ran.";
function durationMsFrom(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) {
    return null;
  }
  return Date.parse(finishedAt) - Date.parse(startedAt);
}
function coverageSummaryFrom(checks) {
  const coverageSummary = { assessed: 0, unassessed: 0, undetermined: 0 };
  for (const check of checks) {
    coverageSummary[check.state] += 1;
  }
  return coverageSummary;
}
function checksFromCoverage(coverage, subscriptionId) {
  return coverage.filter((entry) => entry.subscriptionOrProject === subscriptionId).map((entry) => {
    const outcome = { checkId: entry.checkId, state: entry.state };
    if (entry.reason) {
      outcome.reason = entry.reason;
    }
    if (entry.closer) {
      outcome.closer = entry.closer;
    }
    return outcome;
  });
}
function checksFromFailure(coveredScopes, subscriptionId, cloud = DEFAULT_CLOUD) {
  const covered = new Set(coveredScopes);
  return providerFor(cloud).launchCheckIds.map((checkId) => {
    if (covered.has(`${subscriptionId}:${checkId}`)) {
      return { checkId, state: "assessed" };
    }
    return { checkId, state: "unassessed", reason: FAILED_BEFORE_CHECK };
  });
}
function mergeScanFindings(existing, next, replaceCheckIds, subscriptionId) {
  const target = subscriptionId.toLowerCase();
  return [
    ...existing.filter(
      (finding) => !(replaceCheckIds.has(finding.checkId) && finding.scope.subscriptionOrProject.toLowerCase() === target)
    ),
    ...next
  ];
}
function mergeScanCoverage(existing, next, replaceCheckIds, subscriptionId) {
  const target = subscriptionId.toLowerCase();
  const kept = existing.filter(
    (entry) => !(replaceCheckIds.has(entry.checkId) && entry.subscriptionOrProject.toLowerCase() === target)
  );
  return applyCoverageResults(kept, next);
}
function failureCode(error, harvesting) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "harvest_timeout";
  }
  return error instanceof ScanFailedError || harvesting ? "harvest_failed" : "scan_failed";
}
function scannedScopes(inventory, subscriptionId) {
  return new Set(
    [subscriptionId, ...inventory.resources.map((resource) => scopeOf(inventory.cloud, resource.resourceUri))].filter((key) => key.length > 0).map((key) => key.toLowerCase())
  );
}
function replacedByScan(scopes, key, incomingHasEmptyKey) {
  return key.length === 0 ? incomingHasEmptyKey : scopes.has(key.toLowerCase());
}
function mergeScanInventory(existing, next, subscriptionId) {
  if (!existing) {
    return next;
  }
  const scopes = scannedScopes(next, subscriptionId);
  const incomingHasEmptyKey = next.resources.some((resource) => scopeOf(next.cloud, resource.resourceUri) === "");
  return {
    ...next,
    resources: [
      ...existing.resources.filter(
        (resource) => !replacedByScan(scopes, scopeOf(existing.cloud, resource.resourceUri), incomingHasEmptyKey)
      ),
      ...next.resources
    ]
  };
}
function mergeScanFacts(existing, next, inventory, subscriptionId) {
  const scopes = scannedScopes(inventory, subscriptionId);
  const incomingHasEmptyKey = next.some((row) => scopeOf(inventory.cloud, row.resourceUri) === "");
  return [
    ...existing.filter(
      (row) => !replacedByScan(scopes, scopeOf(inventory.cloud, row.resourceUri), incomingHasEmptyKey)
    ),
    ...next
  ];
}
var ScanFailedError = class extends Error {
  constructor(message, coveredScopes) {
    super(message);
    this.coveredScopes = coveredScopes;
    this.name = "ScanFailedError";
  }
  coveredScopes;
};
function unconfiguredHarvester() {
  return {
    async harvest() {
      rejectUnconfigured();
    }
  };
}
var NO_POST_HARVEST = { persist: async () => void 0, apply: (outputs) => outputs };
var ScanRunner = class {
  constructor(store, harvester, harvestClients = {}, clock = systemClock, log = silentLog, scanTimeoutMs = DEFAULT_SCAN_TIMEOUT_MS) {
    this.store = store;
    this.harvester = harvester;
    this.harvestClients = harvestClients;
    this.clock = clock;
    this.log = log;
    this.scanTimeoutMs = scanTimeoutMs;
  }
  store;
  harvester;
  harvestClients;
  clock;
  log;
  scanTimeoutMs;
  #queues = /* @__PURE__ */ new Map();
  #admissions = /* @__PURE__ */ new Map();
  start(input) {
    const prior = this.#admissions.get(input.orgId) ?? Promise.resolve();
    const admitted = prior.then(() => this.admit(input));
    const settled = admitted.catch(() => void 0);
    this.#admissions.set(input.orgId, settled);
    void settled.then(() => {
      if (this.#admissions.get(input.orgId) === settled) {
        this.#admissions.delete(input.orgId);
      }
    });
    return admitted;
  }
  async admit(input) {
    await this.expireStaleScans(input.orgId, this.clock());
    const existing = await this.store.runningScan(input.orgId, input.subscriptionId);
    if (existing) {
      return { job: existing, started: false, done: Promise.resolve(existing) };
    }
    const job = await this.store.putJob({
      orgId: input.orgId,
      subscriptionId: input.subscriptionId,
      cloud: null,
      actor: input.actor,
      status: "queued",
      complete: false,
      coveredScopes: [],
      createdAt: this.clock(),
      startedAt: null,
      finishedAt: null,
      error: null,
      durationMs: null,
      coverageSummary: EMPTY_COVERAGE_SUMMARY,
      checks: []
    });
    const connected = await this.store.isConnected(input.orgId, input.subscriptionId);
    const tail = this.#queues.get(input.orgId);
    if (tail) {
      this.log.info({ event: "scan.queued", orgId: input.orgId, scanId: job.id }, "scan.queued");
    }
    const done = tail ? tail.then(async () => {
      const abandoned = await this.store.deletion(input.orgId) || connected && !await this.store.isConnected(input.orgId, input.subscriptionId);
      return abandoned ? this.cancel(input.orgId, job) : this.execute(input.orgId, job.id, connected);
    }) : this.execute(input.orgId, job.id, connected);
    const settled = done.catch(() => void 0);
    this.#queues.set(input.orgId, settled);
    void settled.then(() => {
      if (this.#queues.get(input.orgId) === settled) {
        this.#queues.delete(input.orgId);
      }
    });
    done.catch((error) => {
      this.log.error(
        { event: "scan.execution_failed", orgId: input.orgId, scanId: job.id, err: error },
        "scan execution failed"
      );
    });
    return { job, started: true, done };
  }
  async cancel(orgId, job, patch = {}) {
    this.log.info({ event: "scan.cancelled", orgId, scanId: job.id }, "scan.cancelled");
    if (!await this.store.hasOrg(orgId) || await this.store.deletion(orgId) || !await this.store.getJob(orgId, job.id)) {
      return { ...job, ...patch, status: "cancelled" };
    }
    return this.store.patchJob(orgId, job.id, { ...patch, status: "cancelled" });
  }
  async scheduleRetry(orgId, subscriptionId, finishedAt) {
    const { settings } = await this.store.read(orgId, "settings");
    if (!settings.scanScheduleEnabled) {
      return;
    }
    await this.store.updateSchedule(orgId, (schedule) => {
      if ((schedule.retryCounts[subscriptionId] ?? 0) >= settings.scanRetryLimit) {
        return;
      }
      const candidate = addHours(finishedAt, RETRY_DELAY_HOURS);
      if (!schedule.retryAt || Date.parse(candidate) < Date.parse(schedule.retryAt)) {
        schedule.retryAt = candidate;
      }
      if (!schedule.regularRunAt || Date.parse(schedule.retryAt) < Date.parse(schedule.regularRunAt)) {
        schedule.nextRunAt = schedule.retryAt;
      }
    });
  }
  async recordFailure(orgId, job, startedAt, failure) {
    const checks = checksFromFailure(failure.covered, job.subscriptionId, job.cloud ?? DEFAULT_CLOUD);
    const finishedAt = this.clock();
    const errorId = randomUUID();
    const patch = {
      status: "failed",
      complete: false,
      coveredScopes: failure.covered,
      finishedAt,
      error: failure.stored,
      errorId,
      durationMs: durationMsFrom(startedAt, finishedAt),
      coverageSummary: coverageSummaryFrom(checks),
      checks
    };
    const failed = await this.store.getJob(orgId, job.id) ? await this.store.patchJob(orgId, job.id, patch) : { ...job, ...patch };
    if (job.actor === "system") {
      await this.scheduleRetry(orgId, job.subscriptionId, finishedAt);
    }
    this.log.error(
      {
        event: "scan.failed",
        orgId,
        scanId: job.id,
        durationMs: failed.durationMs,
        checkCount: checks.length,
        coverageSummary: failed.coverageSummary,
        errorCode: failure.errorCode,
        errorId,
        err: failure.error
      },
      "scan.failed"
    );
    return failed;
  }
  async expireStaleScans(orgId, now) {
    const { scans } = await this.store.read(orgId, "scans");
    const expired = [];
    for (const job of scans) {
      if (job.status === "running" && job.startedAt !== null && Date.parse(now) - Date.parse(job.startedAt) > this.scanTimeoutMs) {
        const error = new Error(`scan exceeded ${this.scanTimeoutMs}ms`);
        error.name = "TimeoutError";
        expired.push(
          await this.recordFailure(orgId, asMutable(job), job.startedAt ?? now, {
            error,
            errorCode: "harvest_timeout",
            stored: "harvest_timeout",
            covered: []
          })
        );
      }
    }
    return expired;
  }
  async execute(orgId, jobId, connectedAtStart) {
    const current = await this.store.getJob(orgId, jobId);
    if (!current) {
      throw new Error(`scan ${jobId} missing`);
    }
    const startedAt = this.clock();
    await this.store.patchJob(orgId, jobId, { status: "running", startedAt });
    const { signal, release } = this.store.trackScan(orgId);
    const scanFields = { orgId, scanId: jobId };
    this.log.info({ event: "scan.start", ...scanFields }, "scan.start");
    const cancelled = () => this.cancel(orgId, current, { startedAt });
    const deadline = Date.parse(startedAt) + this.scanTimeoutMs;
    const remainingMs = () => Math.max(0, deadline - Date.parse(this.clock()));
    let harvesting = true;
    try {
      const { settings } = await this.store.read(orgId, "settings");
      const result = await abortable(
        signal,
        this.harvester.harvest({
          orgId,
          subscriptionId: current.subscriptionId,
          settings
        }),
        remainingMs()
      );
      harvesting = false;
      if (signal.aborted) {
        return await cancelled();
      }
      await this.store.patchJob(orgId, jobId, { cloud: result.inventory.cloud });
      const checked = runChecks({
        inventory: result.inventory,
        facts: result.facts,
        checkIds: registeredCheckIds(result.inventory.cloud),
        scopes: [current.subscriptionId],
        settings
      });
      const replaceIds = new Set(registeredCheckIds(result.inventory.cloud));
      const provider = providerFor(result.inventory.cloud);
      const clients = typeof this.harvestClients === "function" ? await this.harvestClients({ orgId, subscriptionId: current.subscriptionId }) : this.harvestClients;
      const postHarvest = provider.collectHarvests ? await provider.collectHarvests({
        orgId,
        subscriptionId: current.subscriptionId,
        signal,
        remainingMs,
        clock: this.clock,
        clients,
        store: this.store
      }) : NO_POST_HARVEST;
      if (!postHarvest || signal.aborted) {
        return await cancelled();
      }
      const live = await this.store.getJob(orgId, jobId);
      if (live?.status !== "running") {
        return live ?? await cancelled();
      }
      if (await this.store.deletion(orgId) || connectedAtStart && !await this.store.isConnected(orgId, current.subscriptionId)) {
        return await cancelled();
      }
      await postHarvest.persist();
      const { cloud } = result.inventory;
      await this.store.mergeScan(orgId, cloud, (draft) => {
        draft.inventories[cloud] = mergeScanInventory(
          asMutable(draft.inventories[cloud]),
          result.inventory,
          current.subscriptionId
        );
        draft.facts = mergeScanFacts(draft.facts, result.facts, result.inventory, current.subscriptionId);
        const merged = postHarvest.apply({
          findings: mergeScanFindings(draft.findings, checked.findings, replaceIds, current.subscriptionId),
          coverage: mergeScanCoverage(draft.coverage, checked.coverage, replaceIds, current.subscriptionId)
        });
        draft.findings = merged.findings;
        draft.coverage = merged.coverage;
        refreshCost(draft);
        draft.issues = applyScanToIssues({
          issues: draft.issues,
          findings: merged.findings,
          coverage: draft.coverage,
          scanId: jobId,
          observedAt: result.inventory.observedAt
        });
      });
      const { coverage } = await this.store.read(orgId, "coverage");
      if (connectedAtStart && !await this.store.isConnected(orgId, current.subscriptionId)) {
        await this.store.purgeSubscription(orgId, current.subscriptionId);
        return await cancelled();
      }
      const checks = checksFromCoverage(coverage, current.subscriptionId);
      const finishedAt = this.clock();
      const succeeded = await this.store.patchJob(orgId, jobId, {
        status: "succeeded",
        complete: true,
        coveredScopes: result.coveredScopes,
        finishedAt,
        error: null,
        durationMs: durationMsFrom(startedAt, finishedAt),
        coverageSummary: coverageSummaryFrom(checks),
        checks
      });
      this.log.info(
        {
          event: "scan.finish",
          ...scanFields,
          durationMs: succeeded.durationMs,
          checkCount: checks.length,
          coverageSummary: succeeded.coverageSummary
        },
        "scan.finish"
      );
      return succeeded;
    } catch (error) {
      if (signal.aborted) {
        return await cancelled();
      }
      const errorCode = failureCode(error, harvesting);
      return await this.recordFailure(orgId, await this.store.getJob(orgId, jobId) ?? current, startedAt, {
        error,
        errorCode,
        stored: error instanceof ProviderNotConfiguredError ? PROVIDER_NOT_CONFIGURED : errorCode,
        covered: error instanceof ScanFailedError ? error.coveredScopes : []
      });
    } finally {
      release();
    }
  }
};

// backend/src/role-probe.ts
function presentRoles(cloud) {
  const provider = providerFor(cloud);
  return [...provider.requiredRoles, ...provider.optionalRoles];
}
function probeRoles(cloud, granted) {
  const missing = missingRoles(cloud, granted);
  return {
    roles: [...granted],
    missingRoles: missing,
    healthy: !missing.some((gap) => gap.required)
  };
}

// backend/src/store.ts
var MemoryStore = class {
  constructor(clock = systemClock) {
    this.clock = clock;
  }
  clock;
  #orgs = /* @__PURE__ */ new Map();
  #deletions = /* @__PURE__ */ new Map();
  #running = new RunningScans();
  #seeded = /* @__PURE__ */ new Set();
  org(orgId) {
    if (this.#deletions.has(orgId)) {
      throw new DeletedOrgError(orgId);
    }
    const existing = this.#orgs.get(orgId);
    if (existing) {
      return existing;
    }
    const created = emptyOrg(this.clock());
    this.#orgs.set(orgId, created);
    return created;
  }
  view(orgId) {
    return this.org(orgId);
  }
  snapshot(orgId) {
    const copy = structuredClone(this.org(orgId));
    assertNoSecrets(copy);
    return copy;
  }
  costsOf(orgId) {
    return Object.values(this.org(orgId).costs);
  }
  orgRows(orgId) {
    return Object.entries(rowsPurged(this.#orgs.get(orgId))).reduce(
      (sum, [kind, count]) => kind === "settings" ? sum : sum + count,
      0
    );
  }
  async read(orgId, ...keys) {
    const org = this.org(orgId);
    return Object.fromEntries(keys.map((key) => [key, org[key]]));
  }
  trackScan(orgId) {
    return this.#running.track(orgId);
  }
  async orgIds() {
    return [...this.#orgs.keys()];
  }
  async hasOrg(orgId) {
    return this.#orgs.has(orgId);
  }
  async deletion(orgId) {
    return this.#deletions.get(orgId) ?? null;
  }
  async offboard(orgId, now = this.clock(), trigger = "customer", requestedBy = trigger === "retention" ? "system" : "unknown") {
    const existing = this.#deletions.get(orgId);
    if (existing) {
      return existing;
    }
    const record = deletionRecordFor(this.#orgs.get(orgId), {
      orgId,
      now,
      trigger,
      requestedBy,
      runningScans: this.#running.abortAll(orgId)
    });
    assertNoSecrets(record);
    this.#orgs.delete(orgId);
    this.#deletions.set(orgId, record);
    return record;
  }
  sweepRetention(now = this.clock(), onlyOrgId) {
    return sweepRetention(this, now, onlyOrgId);
  }
  async repurgeDeleted(_now) {
    return 0;
  }
  async nextSequence(orgId, kind) {
    const { sequences } = this.org(orgId);
    sequences[kind] += 1;
    return sequences[kind];
  }
  async putInventory(orgId, inventory) {
    assertNoSecrets(inventory);
    markVerified(inventory);
    const org = this.org(orgId);
    org.inventories[inventory.cloud] = inventory;
    org.inventory = inventory;
    return inventory;
  }
  async putConnection(orgId, input, fixedId) {
    assertNoSecrets(input);
    const existing = fixedId === void 0 ? void 0 : this.org(orgId).connections.find((item) => item.id === fixedId);
    if (existing) {
      return existing;
    }
    const cloud = input.cloud ?? DEFAULT_CLOUD;
    const probed = probeRoles(cloud, input.grantedRoles ?? presentRoles(cloud));
    const connection = {
      id: fixedId ?? `conn-${await this.nextSequence(orgId, "connection")}`,
      cloud,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      roles: probed.roles,
      missingRoles: probed.missingRoles,
      createdAt: this.clock(),
      healthy: probed.healthy
    };
    markVerified(connection);
    const org = this.org(orgId);
    org.connections.push(connection);
    if (fixedId !== void 0) {
      org.sequences.connection = Math.max(org.sequences.connection, Number(fixedId.slice(fixedId.lastIndexOf("-") + 1)) || 0);
    }
    return connection;
  }
  async putCoverage(orgId, coverage) {
    assertNoSecrets(coverage);
    const org = this.org(orgId);
    applyCoverage(org, coverage);
    return org.coverage;
  }
  async putFindings(orgId, findings) {
    assertNoSecrets(findings);
    markVerifiedAll(findings);
    this.org(orgId).findings = findings;
    return findings;
  }
  async putFacts(orgId, facts) {
    assertNoSecrets(facts);
    this.org(orgId).facts = facts;
    return facts;
  }
  async putIssues(orgId, issues) {
    assertNoSecrets(issues);
    markVerifiedAll(issues);
    this.org(orgId).issues = issues;
    return issues;
  }
  async putCost(orgId, cost, subscriptionId = cost?.subscriptionId) {
    if (cost) {
      assertNoSecrets(cost);
    }
    applyCost(this.org(orgId), cost, subscriptionId);
    return cost;
  }
  async putCommitments(orgId, commitments, subscriptionId = commitments?.subscriptionId) {
    if (commitments) {
      assertNoSecrets(commitments);
    }
    applyCommitments(this.org(orgId), commitments, subscriptionId);
    return commitments;
  }
  async putBudgets(orgId, budgets) {
    if (budgets) {
      assertNoSecrets(budgets);
    }
    this.org(orgId).budgets = budgets;
    return budgets;
  }
  async putAlerts(orgId, alerts) {
    if (alerts) {
      assertNoSecrets(alerts);
    }
    this.org(orgId).alerts = alerts;
    return alerts;
  }
  async putSettings(orgId, settings) {
    assertNoSecrets(settings);
    const org = this.org(orgId);
    org.settings = settings;
    retagInventories(org, settings.ownerTagKey);
    return settings;
  }
  async putContract(orgId, contract) {
    if (contract) {
      assertNoSecrets(contract);
    }
    this.org(orgId).contract = contract;
    return contract;
  }
  async updateSchedule(orgId, mutate) {
    const { schedule, settings } = this.org(orgId);
    mutate(schedule, settings);
    return schedule;
  }
  async putJob(input, fixedId) {
    assertNoSecrets(input);
    const existing = fixedId === void 0 ? void 0 : this.org(input.orgId).scans.find((item) => item.id === fixedId);
    if (existing) {
      return existing;
    }
    const job = { ...input, id: fixedId ?? `scan-${await this.nextSequence(input.orgId, "scan")}` };
    const org = this.org(input.orgId);
    markVerified(job);
    org.scans.push(job);
    if (fixedId !== void 0) {
      org.sequences.scan = Math.max(org.sequences.scan, Number(fixedId.slice(fixedId.lastIndexOf("-") + 1)) || 0);
    }
    if (org.scans.length > MAX_SCANS_PER_ORG) {
      org.scans = pruneScans(org.scans);
    }
    return job;
  }
  async getJob(orgId, jobId) {
    return this.org(orgId).scans.find((job) => job.id === jobId);
  }
  async patchJob(orgId, jobId, patch) {
    const org = this.org(orgId);
    const index = org.scans.findIndex((job) => job.id === jobId);
    const current = org.scans[index];
    if (index < 0 || !current) {
      throw new Error(`scan ${jobId} missing`);
    }
    const next = { ...current, ...patch, id: current.id, orgId: current.orgId };
    assertNoSecrets(next);
    markVerified(next);
    org.scans[index] = next;
    return next;
  }
  async runningScan(orgId, subscriptionId) {
    return this.org(orgId).scans.find(
      (job) => job.subscriptionId === subscriptionId && (job.status === "queued" || job.status === "running")
    );
  }
  async mergeScan(orgId, cloud, merge) {
    const org = this.org(orgId);
    const draft = {
      inventories: { ...org.inventories },
      facts: org.facts,
      findings: org.findings,
      coverage: org.coverage,
      issues: org.issues,
      cost: org.cost,
      costs: org.costs
    };
    merge(draft);
    const inventory = draft.inventories[cloud];
    assertNoSecrets({ inventory, facts: draft.facts, findings: draft.findings, coverage: draft.coverage, issues: draft.issues });
    if (inventory) {
      markVerified(inventory);
      org.inventory = inventory;
    }
    markVerifiedAll(draft.findings);
    markVerifiedAll(draft.issues);
    org.inventories = draft.inventories;
    org.facts = draft.facts;
    org.findings = draft.findings;
    org.coverage = draft.coverage;
    org.issues = draft.issues;
    org.cost = draft.cost;
  }
  async seeded(orgId) {
    return this.#seeded.has(orgId);
  }
  async markSeeded(orgId) {
    this.org(orgId);
    this.#seeded.add(orgId);
  }
  async isConnected(orgId, subscriptionId) {
    const target = subscriptionId.toLowerCase();
    return this.org(orgId).connections.some((item) => item.subscriptionId.toLowerCase() === target);
  }
  async patchConnection(orgId, connectionId, patch) {
    const connection = this.org(orgId).connections.find((item) => item.id === connectionId);
    if (!connection) {
      return null;
    }
    if (patch.healthy !== void 0) {
      connection.healthy = patch.healthy;
    }
    if (patch.roles !== void 0) {
      connection.roles = patch.roles;
    }
    if (patch.missingRoles !== void 0) {
      connection.missingRoles = patch.missingRoles;
    }
    assertNoSecrets(connection);
    markVerified(connection);
    return connection;
  }
  async purgeSubscription(orgId, subscriptionId) {
    const org = this.org(orgId);
    const target = subscriptionId.toLowerCase();
    if (!org.connections.some((connection) => connection.subscriptionId.toLowerCase() === target)) {
      dropSubscription(org, subscriptionId);
    }
  }
  async deleteConnection(orgId, connectionId) {
    const org = this.org(orgId);
    const next = org.connections.filter((connection) => connection.id !== connectionId);
    if (next.length === org.connections.length) {
      return false;
    }
    const removed = org.connections.find((connection) => connection.id === connectionId);
    org.connections = next;
    if (removed && !next.some((connection) => connection.subscriptionId.toLowerCase() === removed.subscriptionId.toLowerCase())) {
      dropSubscription(org, removed.subscriptionId);
    }
    return true;
  }
};

// backend/src/cli.ts
var EXIT_OK = 0;
var EXIT_FAILED = 1;
var EXIT_USAGE = 2;
var CLI_ORG_ID = "local";
var DEFAULT_WORKSPACE_DIRNAME = "farside-engagements";
var ROLE_LISTING_CLOSER = "Live role listing is leftover (#55 / #192)";
var USAGE = `Usage:
  farside connect --cloud <azure|gcp> [--workspace <dir>] [--fixture]
  farside scan --cloud <azure|gcp> --scope <id> [--workspace <dir>] [--fixture]
  farside findings [--workspace <dir>]
  farside export [--workspace <dir>]
  farside report [--workspace <dir>]
`;
var COMMANDS = ["connect", "scan", "findings", "export", "report"];
var WORKSPACE_FILES = {
  connect: "connect.json",
  findings: "findings.json",
  inventory: "inventory.json",
  coverage: "coverage.json",
  issues: "issues.json",
  cost: "cost.json"
};
function defaultWorkspaceDir(home = homedir2()) {
  return join2(home, DEFAULT_WORKSPACE_DIRNAME);
}
function isCommand(value) {
  return COMMANDS.includes(value);
}
function isCloud(value) {
  return CLOUDS.includes(value);
}
function parseArgv(argv) {
  const flags = { fixture: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === void 0) {
      break;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--fixture") {
      flags.fixture = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let value = eq === -1 ? void 0 : arg.slice(eq + 1);
      if (value === void 0) {
        const next = argv[index + 1];
        if (!next || next.startsWith("--")) {
          return { error: `missing value for --${key}` };
        }
        value = next;
        index += 1;
      }
      if (key === "cloud") {
        if (!isCloud(value)) {
          return { error: "cloud must be azure or gcp" };
        }
        flags.cloud = value;
        continue;
      }
      if (key === "scope" || key === "workspace") {
        flags[key] = value;
        continue;
      }
      if (isTokenFlag(key)) {
        return { error: TOKEN_FLAG_MESSAGE };
      }
      return { error: `unknown option --${key}` };
    }
    if (flags.command) {
      return { error: `unexpected argument '${arg}'` };
    }
    if (!isCommand(arg)) {
      return { error: `unknown command '${arg}'` };
    }
    flags.command = arg;
  }
  return { flags };
}
function writeLine(stream, value) {
  stream.write(`${typeof value === "string" ? value : JSON.stringify(value)}
`);
}
function writeWorkspaceFile(dir, name, value) {
  assertNoSecrets(value);
  writeFileSync(join2(dir, name), `${JSON.stringify(value, null, 2)}
`);
}
function readWorkspaceFile(dir, name) {
  return JSON.parse(readFileSync(join2(dir, name), "utf8"));
}
function resolveWorkspace(flags, io) {
  return flags.workspace ?? defaultWorkspaceDir(io.env?.HOME ?? homedir2());
}
function expectedRoleGaps(cloud) {
  return missingRoles(cloud, []);
}
function runConnect(flags, io) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (!flags.cloud) {
    writeLine(stderr, USAGE.trimEnd());
    return EXIT_USAGE;
  }
  const dir = resolveWorkspace(flags, io);
  mkdirSync(dir, { recursive: true });
  if (flags.fixture) {
    const report2 = {
      cloud: flags.cloud,
      workspace: dir,
      credentials: { present: true, source: "fixture" },
      missingRoles: [],
      roleListing: "fixture"
    };
    writeWorkspaceFile(dir, WORKSPACE_FILES.connect, report2);
    writeLine(stdout, report2);
    return EXIT_OK;
  }
  const probe = io.probe?.(flags.cloud) ?? probeLocalCredentials(flags.cloud, io.env ?? process.env);
  const granted = io.grantedRoles;
  const report = granted === void 0 ? {
    cloud: flags.cloud,
    workspace: dir,
    credentials: probe,
    missingRoles: probe.present ? [] : expectedRoleGaps(flags.cloud),
    expectedRoles: expectedRoleGaps(flags.cloud),
    roleListing: "unverified",
    closer: ROLE_LISTING_CLOSER
  } : {
    cloud: flags.cloud,
    workspace: dir,
    credentials: probe,
    missingRoles: missingRoles(flags.cloud, granted),
    roleListing: "checked"
  };
  writeWorkspaceFile(dir, WORKSPACE_FILES.connect, report);
  writeLine(stdout, report);
  if (!probe.present || report.missingRoles.some((gap) => gap.required)) {
    return EXIT_FAILED;
  }
  return EXIT_OK;
}
async function runScan(flags, io) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (!flags.cloud || !flags.scope) {
    writeLine(stderr, USAGE.trimEnd());
    return EXIT_USAGE;
  }
  const dir = resolveWorkspace(flags, io);
  const clock = io.clock ?? systemClock;
  if (!flags.fixture) {
    const probe = io.probe?.(flags.cloud) ?? probeLocalCredentials(flags.cloud, io.env ?? process.env);
    if (!probe.present) {
      writeLine(stderr, probe.error ?? "signed-in Azure CLI / DefaultAzureCredential or GCP Application Default Credentials required");
      return EXIT_FAILED;
    }
    const gaps = missingRoles(flags.cloud, io.grantedRoles ?? []);
    if (gaps.length > 0) {
      writeLine(stderr, { missingRoles: gaps });
    }
  }
  const store = new MemoryStore(clock);
  const harvester = flags.fixture ? providerFor(flags.cloud).harvester(clock) : unconfiguredHarvester();
  const runner = new ScanRunner(
    store,
    harvester,
    flags.fixture ? {
      costClient: fixtureCostClient(),
      commitmentClient: fixtureCommitmentClient(),
      budgetClient: fixtureBudgetClient()
    } : {},
    clock
  );
  const { done } = await runner.start({
    orgId: CLI_ORG_ID,
    subscriptionId: flags.scope,
    actor: "user"
  });
  const job = await done;
  if (job.status !== "succeeded") {
    writeLine(stderr, job.error ?? "scan failed");
    return EXIT_FAILED;
  }
  const org = await store.read(
    CLI_ORG_ID,
    "findings",
    "inventories",
    "inventory",
    "coverage",
    "issues",
    "cost"
  );
  const inventory = org.inventories[flags.cloud] ?? org.inventory;
  mkdirSync(dir, { recursive: true });
  writeWorkspaceFile(dir, WORKSPACE_FILES.findings, asMutable(org.findings));
  writeWorkspaceFile(dir, WORKSPACE_FILES.inventory, asMutable(inventory));
  writeWorkspaceFile(dir, WORKSPACE_FILES.coverage, asMutable(org.coverage));
  writeWorkspaceFile(dir, WORKSPACE_FILES.issues, asMutable(org.issues));
  writeWorkspaceFile(dir, WORKSPACE_FILES.cost, asMutable(org.cost));
  writeLine(stdout, {
    status: job.status,
    scanId: job.id,
    cloud: flags.cloud,
    scope: flags.scope,
    coverageSummary: job.coverageSummary
  });
  return EXIT_OK;
}
function runFindings(flags, io) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const dir = resolveWorkspace(flags, io);
  try {
    const findings = readWorkspaceFile(dir, WORKSPACE_FILES.findings);
    assertNoSecrets(findings);
    writeLine(stdout, findings);
    return EXIT_OK;
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : "findings failed");
    return EXIT_FAILED;
  }
}
function writeExportFiles(dir, exportedAt) {
  const issues = readWorkspaceFile(dir, WORKSPACE_FILES.issues);
  const inventory = readWorkspaceFile(dir, WORKSPACE_FILES.inventory);
  const cost = readWorkspaceFile(dir, WORKSPACE_FILES.cost);
  assertNoSecrets({ issues, inventory, cost });
  const envelopes = [
    exportIssues(CLI_ORG_ID, issues, exportedAt),
    exportInventory(CLI_ORG_ID, inventory, exportedAt),
    exportCost(CLI_ORG_ID, cost, exportedAt)
  ];
  mkdirSync(dir, { recursive: true });
  for (const envelope of envelopes) {
    if (envelope.format !== EXPORT_FORMAT) {
      throw new Error("export format drifted");
    }
    writeWorkspaceFile(dir, exportFilename(envelope.kind), envelope);
  }
  return { issues, inventory, cost, envelopes };
}
function runExport(flags, io) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const dir = resolveWorkspace(flags, io);
  const clock = io.clock ?? systemClock;
  try {
    const { envelopes } = writeExportFiles(dir, clock());
    writeLine(
      stdout,
      envelopes.map((envelope) => exportFilename(envelope.kind))
    );
    return EXIT_OK;
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : "export failed");
    return EXIT_FAILED;
  }
}
function runReport(flags, io) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const dir = resolveWorkspace(flags, io);
  const clock = io.clock ?? systemClock;
  try {
    const exportedAt = clock();
    const { issues, cost, envelopes } = writeExportFiles(dir, exportedAt);
    const findings = readWorkspaceFile(dir, WORKSPACE_FILES.findings);
    const coverage = readWorkspaceFile(dir, WORKSPACE_FILES.coverage);
    const exportedIssues = envelopes.find((envelope) => envelope.kind === "issues");
    const exportedCost = envelopes.find((envelope) => envelope.kind === "cost");
    if (!exportedIssues || !exportedCost) {
      writeLine(stderr, "export format drifted");
      return EXIT_FAILED;
    }
    const html = buildConsultantReport({
      issues,
      findings,
      coverage,
      cost,
      exportedIssues,
      exportedCost,
      now: exportedAt
    });
    assertNoSecrets(html);
    writeFileSync(join2(dir, REPORT_FILENAME), html);
    writeLine(stdout, { report: join2(dir, REPORT_FILENAME) });
    return EXIT_OK;
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : "report failed");
    return EXIT_FAILED;
  }
}
async function runCli(argv, io = {}) {
  const stderr = io.stderr ?? process.stderr;
  const parsed = parseArgv(argv);
  if (parsed.help) {
    writeLine(io.stdout ?? process.stdout, USAGE.trimEnd());
    return EXIT_OK;
  }
  if (parsed.error || !parsed.flags?.command) {
    writeLine(stderr, parsed.error ?? USAGE.trimEnd());
    return EXIT_USAGE;
  }
  if (parsed.flags.command === "connect") {
    return runConnect(parsed.flags, io);
  }
  if (parsed.flags.command === "scan") {
    return runScan(parsed.flags, io);
  }
  if (parsed.flags.command === "findings") {
    return runFindings(parsed.flags, io);
  }
  if (parsed.flags.command === "export") {
    return runExport(parsed.flags, io);
  }
  return runReport(parsed.flags, io);
}
function isMain() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}
if (isMain()) {
  process.exit(await runCli(process.argv.slice(2)));
}
export {
  CLI_ORG_ID,
  DEFAULT_WORKSPACE_DIRNAME,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  ROLE_LISTING_CLOSER,
  USAGE,
  defaultWorkspaceDir,
  runCli
};
