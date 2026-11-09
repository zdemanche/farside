#!/usr/bin/env node
/**
 * Azure test estate seed (E1-S5, #31 #32 #33 #35).
 *
 * Dry-run by default: prints the ARM operations built from docs/azure/ground-truth.json.
 * `--apply` calls ARM REST with a bearer token (AZURE_ACCESS_TOKEN, else `az account
 * get-access-token`). No token or no main subscription id is a clean skip (exit 0).
 * Subscription creation needs a billing scope and `--create-subscriptions`.
 * `--apply --destroy` deletes the seed resource groups and the budget.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MANIFEST_PATH = join(ROOT, "docs/azure/ground-truth.json");
export const ARM = "https://management.azure.com";

export const API = {
  resourceGroups: "2021-04-01",
  subscriptions: "2022-12-01",
  aliases: "2021-10-01",
  compute: "2023-04-02",
  vm: "2024-03-01",
  network: "2023-09-01",
  web: "2023-01-01",
  sql: "2021-11-01",
  vault: "2023-04-01",
  budgets: "2023-05-01",
};

export const SEED_TAG = { "farside-seed": "e1-s5" };

export const DEFAULT_CONFIG = {
  location: "eastus",
  resourceGroups: { main: "farside-test-seed", "empty-no-budget": "farside-test-empty" },
  subscriptions: {
    main: { subscriptionId: "", displayName: "farside-test-main" },
    "empty-no-budget": { subscriptionId: "", displayName: "farside-test-empty" },
  },
  create: { enabled: false, billingScope: "", workload: "DevTest" },
  budget: { amount: 200, thresholdPercent: 80, contactEmails: [] },
  appRegistrationTenantId: "",
  vm: { adminUsername: "farside", sshPublicKey: "" },
  sql: { adminLogin: "", adminObjectId: "", tenantId: "" },
};

export function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function seedItems(manifest) {
  return (manifest.items ?? []).filter((item) => item.subscription === "main");
}

/** Config file (optional) merged over defaults, then env overrides. */
export function resolveConfig(env = process.env, file = null) {
  const base = structuredClone(DEFAULT_CONFIG);
  const merged = file ? deepMerge(base, file) : base;
  const set = (value, apply) => {
    if (value) apply(value);
  };
  set(env.AZURE_SUBSCRIPTION_ID, (v) => (merged.subscriptions.main.subscriptionId = v));
  set(env.AZURE_EMPTY_SUBSCRIPTION_ID, (v) => (merged.subscriptions["empty-no-budget"].subscriptionId = v));
  set(env.AZURE_LOCATION, (v) => (merged.location = v));
  set(env.AZURE_BILLING_SCOPE, (v) => (merged.create.billingScope = v));
  set(env.AZURE_BUDGET_CONTACT_EMAIL, (v) => (merged.budget.contactEmails = v.split(",").map((s) => s.trim())));
  set(env.AZURE_BUDGET_AMOUNT, (v) => (merged.budget.amount = Number(v)));
  set(env.AZURE_APP_REGISTRATION_TENANT_ID, (v) => (merged.appRegistrationTenantId = v));
  set(env.AZURE_SEED_SSH_PUBLIC_KEY, (v) => (merged.vm.sshPublicKey = v));
  set(env.AZURE_SQL_ADMIN_LOGIN, (v) => (merged.sql.adminLogin = v));
  set(env.AZURE_SQL_ADMIN_OBJECT_ID, (v) => (merged.sql.adminObjectId = v));
  set(env.AZURE_SQL_ADMIN_TENANT_ID, (v) => (merged.sql.tenantId = v));
  return merged;
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof target[key] === "object") {
      target[key] = deepMerge(target[key] ?? {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/** Config fields an apply needs. Missing main subscription id is a skip, not an error. */
export function missingForApply(config, { createSubscriptions = false, destroy = false } = {}) {
  if (createSubscriptions) {
    return config.create.billingScope ? [] : ["AZURE_BILLING_SCOPE (billing scope for subscription aliases)"];
  }
  const missing = [];
  if (!config.subscriptions["empty-no-budget"].subscriptionId) {
    missing.push("AZURE_EMPTY_SUBSCRIPTION_ID (or create it with --create-subscriptions)");
  }
  if (destroy) {
    return missing;
  }
  if (!config.appRegistrationTenantId) {
    missing.push("AZURE_APP_REGISTRATION_TENANT_ID (tenant rule: estate must sit in another tenant)");
  }
  if (config.budget.contactEmails.length === 0) {
    missing.push("AZURE_BUDGET_CONTACT_EMAIL (cost guard alert recipient)");
  }
  if (!config.vm.sshPublicKey) {
    missing.push("AZURE_SEED_SSH_PUBLIC_KEY (VM admin key; no passwords)");
  }
  if (!config.sql.adminLogin || !config.sql.adminObjectId) {
    missing.push("AZURE_SQL_ADMIN_LOGIN and AZURE_SQL_ADMIN_OBJECT_ID (Entra-only SQL admin)");
  }
  return missing;
}

const name = (id) => `fs-${id}`;
const PLACEHOLDER_SUB = "<main-subscription-id>";
const PLACEHOLDER_EMPTY = "<empty-subscription-id>";

function suffixOf(subscriptionId) {
  return (subscriptionId || "00000000").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
}

function firstOfMonth(now) {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

/**
 * Pure plan: ordered ARM operations plus manual steps for items ARM cannot seed
 * honestly (certificates need a PFX with a chosen expiry).
 */
export function buildSeedPlan(manifest, config, { now = new Date().toISOString() } = {}) {
  const items = seedItems(manifest);
  const mainSub = config.subscriptions.main.subscriptionId || PLACEHOLDER_SUB;
  const emptySub = config.subscriptions["empty-no-budget"].subscriptionId || PLACEHOLDER_EMPTY;
  const rg = config.resourceGroups.main;
  const emptyRg = config.resourceGroups["empty-no-budget"];
  const location = config.location;
  const suffix = suffixOf(config.subscriptions.main.subscriptionId);
  const rgPath = `/subscriptions/${mainSub}/resourceGroups/${rg}`;
  const id = (provider, resource) => `${rgPath}/providers/${provider}/${resource}`;
  const ops = [];
  const manual = [];
  const op = (phase, itemId, method, path, apiVersion, body, extra = {}) =>
    ops.push({ phase, itemId, method, path, apiVersion, ...(body ? { body } : {}), ...extra });

  op(1, "rg-main", "PUT", rgPath, API.resourceGroups, { location, tags: SEED_TAG });
  op(1, "rg-empty-no-budget", "PUT", `/subscriptions/${emptySub}/resourceGroups/${emptyRg}`, API.resourceGroups, {
    location,
    tags: { ...SEED_TAG, "farside-role": "empty-no-budget" },
  });

  const byId = new Map(items.map((item) => [item.id, item]));
  const vms = items.filter((item) => item.type === "Microsoft.Compute/virtualMachines");
  const pipFor = new Map(
    items
      .filter((item) => item.type === "Microsoft.Network/publicIPAddresses" && item.properties?.associatedTo)
      .map((item) => [item.properties.associatedTo, item.id]),
  );
  const subnets = [{ name: "default", properties: { addressPrefix: "10.42.1.0/24" } }];
  const vnetId = id("Microsoft.Network", "virtualNetworks/fs-vnet");
  const subnetId = `${vnetId}/subnets/default`;
  const vault = items.find((item) => item.properties?.vaultId)?.properties.vaultId;
  let sqlServer = null;

  for (const item of items) {
    const tags = item.tags ?? {};
    const props = item.properties ?? {};
    switch (item.type) {
      case "Microsoft.Network/publicIPAddresses":
        op(2, item.id, "PUT", id("Microsoft.Network", `publicIPAddresses/${name(item.id)}`), API.network, {
          location,
          sku: { name: "Standard" },
          properties: { publicIPAllocationMethod: "Static" },
          tags,
        });
        break;
      case "Microsoft.Network/natGateways": {
        const attached = (props.attachedSubnetCount ?? 0) > 0;
        const pipName = `${name(item.id)}-pip`;
        if (attached) {
          op(2, item.id, "PUT", id("Microsoft.Network", `publicIPAddresses/${pipName}`), API.network, {
            location,
            sku: { name: "Standard" },
            properties: { publicIPAllocationMethod: "Static" },
            tags,
          });
        }
        op(3, item.id, "PUT", id("Microsoft.Network", `natGateways/${name(item.id)}`), API.network, {
          location,
          sku: { name: props.skuName ?? "Standard" },
          properties: attached
            ? { publicIpAddresses: [{ id: id("Microsoft.Network", `publicIPAddresses/${pipName}`) }] }
            : {},
          tags,
        });
        if (attached) {
          subnets.push({
            name: `nat-${item.id}`,
            properties: {
              addressPrefix: `10.42.${subnets.length + 1}.0/24`,
              natGateway: { id: id("Microsoft.Network", `natGateways/${name(item.id)}`) },
            },
          });
        }
        if ((props.byteCount ?? 0) > 0) {
          manual.push({ itemId: item.id, step: "Traffic (byteCount > 0) is runtime: send outbound traffic from the NAT subnet before the scan." });
        }
        break;
      }
      case "Microsoft.Compute/disks":
        op(5, item.id, "PUT", id("Microsoft.Compute", `disks/${name(item.id)}`), API.compute, {
          location,
          sku: { name: "Standard_LRS" },
          properties: { creationData: { createOption: "Empty" }, diskSizeGB: props.sizeGb ?? 32 },
          tags,
        });
        break;
      case "Microsoft.Compute/snapshots": {
        const source = items.find((other) => other.type === "Microsoft.Compute/disks");
        op(6, item.id, "PUT", id("Microsoft.Compute", `snapshots/${name(item.id)}`), API.compute, {
          location,
          sku: { name: "Standard_LRS" },
          properties: {
            creationData: {
              createOption: "Copy",
              sourceResourceId: id("Microsoft.Compute", `disks/${name(source?.id ?? "disk-unattached")}`),
            },
          },
          tags,
        });
        if ((props.ageDays ?? 0) >= (manifest.snapshotRetentionDays ?? 30)) {
          manual.push({
            itemId: item.id,
            step: `ageDays ${props.ageDays} is wall-clock: ARM cannot backdate a snapshot. It flags once it is older than ${manifest.snapshotRetentionDays} days.`,
          });
        }
        break;
      }
      case "Microsoft.Compute/virtualMachines": {
        const nic = `${name(item.id)}-nic`;
        const pip = pipFor.get(item.id);
        op(7, item.id, "PUT", id("Microsoft.Network", `networkInterfaces/${nic}`), API.network, {
          location,
          properties: {
            ipConfigurations: [
              {
                name: "ipconfig1",
                properties: {
                  subnet: { id: subnetId },
                  privateIPAllocationMethod: "Dynamic",
                  ...(pip ? { publicIPAddress: { id: id("Microsoft.Network", `publicIPAddresses/${name(pip)}`) } } : {}),
                },
              },
            ],
          },
          tags,
        });
        const dataDisks = items
          .filter((disk) => disk.type === "Microsoft.Compute/disks" && disk.properties?.attachedTo === item.id)
          .map((disk, lun) => ({
            lun,
            createOption: "Attach",
            managedDisk: { id: id("Microsoft.Compute", `disks/${name(disk.id)}`) },
          }));
        op(8, item.id, "PUT", id("Microsoft.Compute", `virtualMachines/${name(item.id)}`), API.vm, {
          location,
          properties: {
            hardwareProfile: { vmSize: props.vmSize ?? props.skuName ?? "Standard_B1s" },
            storageProfile: {
              imageReference: {
                publisher: "Canonical",
                offer: "0001-com-ubuntu-server-jammy",
                sku: "22_04-lts-gen2",
                version: "latest",
              },
              osDisk: { createOption: "FromImage", managedDisk: { storageAccountType: "Standard_LRS" }, deleteOption: "Delete" },
              dataDisks,
            },
            osProfile: {
              computerName: name(item.id).slice(0, 15),
              adminUsername: config.vm.adminUsername,
              linuxConfiguration: {
                disablePasswordAuthentication: true,
                ssh: {
                  publicKeys: [
                    {
                      path: `/home/${config.vm.adminUsername}/.ssh/authorized_keys`,
                      keyData: config.vm.sshPublicKey || "<ssh-public-key>",
                    },
                  ],
                },
              },
            },
            networkProfile: { networkInterfaces: [{ id: id("Microsoft.Network", `networkInterfaces/${nic}`) }] },
          },
          tags,
        });
        if (props.powerState === "stopped") {
          op(9, item.id, "POST", `${id("Microsoft.Compute", `virtualMachines/${name(item.id)}`)}/powerOff`, API.vm);
        } else if (props.powerState === "deallocated") {
          op(9, item.id, "POST", `${id("Microsoft.Compute", `virtualMachines/${name(item.id)}`)}/deallocate`, API.vm);
        }
        if (props.protected === true) {
          const container = `iaasvmcontainer;iaasvmcontainerv2;${rg};${name(item.id)}`;
          const vaultPath = id("Microsoft.RecoveryServices", `vaults/fs-${vault ?? "vault-main"}`);
          op(
            10,
            item.id,
            "PUT",
            `${vaultPath}/backupFabrics/Azure/protectionContainers/${container}/protectedItems/vm;${container.slice("iaasvmcontainer;".length)}`,
            API.vault,
            {
              properties: {
                protectedItemType: "Microsoft.Compute/virtualMachines",
                sourceResourceId: id("Microsoft.Compute", `virtualMachines/${name(item.id)}`),
                policyId: `${vaultPath}/backupPolicies/DefaultPolicy`,
              },
            },
          );
        }
        break;
      }
      case "Microsoft.Web/serverfarms": {
        op(11, item.id, "PUT", id("Microsoft.Web", `serverfarms/${name(item.id)}`), API.web, {
          location,
          kind: "linux",
          sku: { name: props.skuName ?? "S1" },
          properties: { reserved: true },
          tags,
        });
        for (let site = 0; site < (props.numberOfSites ?? 0); site += 1) {
          op(11, item.id, "PUT", id("Microsoft.Web", `sites/fs-site-${suffix}-${site + 1}`), API.web, {
            location,
            kind: "app,linux",
            properties: { serverFarmId: id("Microsoft.Web", `serverfarms/${name(item.id)}`), httpsOnly: true },
            tags,
          });
        }
        break;
      }
      case "Microsoft.Network/loadBalancers": {
        const count = props.backendAddressCount ?? 0;
        op(12, item.id, "PUT", id("Microsoft.Network", `loadBalancers/${name(item.id)}`), API.network, {
          location,
          sku: { name: props.skuName ?? "Standard" },
          properties: {
            frontendIPConfigurations: [
              { name: "frontend", properties: { subnet: { id: subnetId }, privateIPAllocationMethod: "Dynamic" } },
            ],
            backendAddressPools: [
              {
                name: "backend",
                properties: {
                  loadBalancerBackendAddresses: Array.from({ length: count }, (_, index) => ({
                    name: `addr-${index + 1}`,
                    properties: { ipAddress: `10.42.1.${10 + index}`, virtualNetwork: { id: vnetId } },
                  })),
                },
              },
            ],
          },
          tags,
        });
        if ((props.byteCount ?? 0) > 0) {
          manual.push({ itemId: item.id, step: "Traffic (byteCount > 0) is runtime: send traffic to the frontend before the scan." });
        }
        break;
      }
      case "Microsoft.Sql/servers/databases": {
        if (!sqlServer) {
          sqlServer = `fs-sql-${suffix}`;
          op(13, item.id, "PUT", id("Microsoft.Sql", `servers/${sqlServer}`), API.sql, {
            location,
            properties: {
              minimalTlsVersion: "1.2",
              publicNetworkAccess: "Disabled",
              administrators: {
                administratorType: "ActiveDirectory",
                azureADOnlyAuthentication: true,
                login: config.sql.adminLogin || "<sql-admin-login>",
                sid: config.sql.adminObjectId || "<sql-admin-object-id>",
                tenantId: config.sql.tenantId || undefined,
              },
            },
            tags: SEED_TAG,
          });
        }
        const zone = props.zoneRedundant === true;
        const dbPath = id("Microsoft.Sql", `servers/${sqlServer}/databases/${name(item.id)}`);
        op(13, item.id, "PUT", dbPath, API.sql, {
          location,
          sku: zone ? { name: "GP_S_Gen5_1", tier: "GeneralPurpose" } : { name: "Basic", tier: "Basic" },
          properties: {
            zoneRedundant: zone,
            requestedBackupStorageRedundancy: props.backupRedundancy ?? "Geo",
          },
          tags,
        });
        if (props.protected === true) {
          op(13, item.id, "PUT", `${dbPath}/backupLongTermRetentionPolicies/default`, API.sql, {
            properties: { weeklyRetention: "P4W" },
          });
          manual.push({
            itemId: item.id,
            step: "Protected SQL is seeded as a long-term retention policy. Confirm the backup check reads it on the live run (E1-S7).",
          });
        }
        break;
      }
      case "Microsoft.Consumption/budgets":
        for (const budgetName of props.budgetNames ?? ["farside-test-guard"]) {
          op(14, item.id, "PUT", `/subscriptions/${mainSub}/providers/Microsoft.Consumption/budgets/${budgetName}`, API.budgets, {
            properties: {
              category: "Cost",
              amount: config.budget.amount,
              timeGrain: "Monthly",
              timePeriod: { startDate: firstOfMonth(now) },
              notifications: {
                actualOverThreshold: {
                  enabled: true,
                  operator: "GreaterThan",
                  threshold: config.budget.thresholdPercent,
                  thresholdType: "Actual",
                  contactEmails: config.budget.contactEmails.length > 0 ? config.budget.contactEmails : ["<contact-email>"],
                },
              },
            },
          });
        }
        break;
      case "Microsoft.Web/certificates":
      case "Microsoft.Network/applicationGateways":
        manual.push({
          itemId: item.id,
          step: `Upload a self-signed PFX expiring ${props.expirationDate} (${props.daysRemaining} days) to ${item.type} in ${rg}. ARM cannot mint the certificate; Key Vault or openssl does.`,
        });
        break;
      default:
        manual.push({ itemId: item.id, step: `No ARM builder for ${item.type}.` });
    }
  }

  if (vault) {
    op(10, vault, "PUT", id("Microsoft.RecoveryServices", `vaults/fs-${vault}`), API.vault, {
      location,
      sku: { name: "RS0", tier: "Standard" },
      properties: { publicNetworkAccess: "Enabled" },
      tags: SEED_TAG,
    }, { first: true });
  }
  op(4, "vnet", "PUT", vnetId, API.network, {
    location,
    properties: { addressSpace: { addressPrefixes: ["10.42.0.0/16"] }, subnets },
    tags: SEED_TAG,
  });

  const ordered = ops
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.phase - b.entry.phase || Number(Boolean(b.entry.first)) - Number(Boolean(a.entry.first)) || a.index - b.index)
    .map(({ entry }) => {
      const { first: _first, ...rest } = entry;
      return rest;
    });
  if (!byId.has("budget-main")) {
    manual.push({ itemId: "budget-main", step: "Manifest has no budget item; the cost guard is missing." });
  }
  return { subscriptions: { main: mainSub, emptyNoBudget: emptySub }, operations: ordered, manual };
}

/**
 * Subscription aliases (Microsoft.Subscription/aliases). Needs a billing scope:
 * MCA invoice section or EA enrollment account. Off unless config.create.enabled
 * or --create-subscriptions.
 */
export function buildSubscriptionPlan(config) {
  return {
    subscriptions: { main: "<from-alias>", emptyNoBudget: "<from-alias>" },
    operations: ["main", "empty-no-budget"].map((key) => {
      const sub = config.subscriptions[key];
      return {
        phase: 0,
        itemId: `subscription-${key}`,
        method: "PUT",
        path: `/providers/Microsoft.Subscription/aliases/${sub.displayName}`,
        apiVersion: API.aliases,
        body: {
          properties: {
            displayName: sub.displayName,
            billingScope: config.create.billingScope || "<billing-scope>",
            workload: config.create.workload,
          },
        },
      };
    }),
    manual: [
      {
        itemId: "subscriptions",
        step: "After the aliases succeed, read each alias's subscriptionId and set AZURE_SUBSCRIPTION_ID / AZURE_EMPTY_SUBSCRIPTION_ID. Move both into a tenant that is not the app-registration tenant before seeding.",
      },
    ],
  };
}

export function buildDestroyPlan(manifest, config) {
  const mainSub = config.subscriptions.main.subscriptionId || PLACEHOLDER_SUB;
  const emptySub = config.subscriptions["empty-no-budget"].subscriptionId || PLACEHOLDER_EMPTY;
  const budget = seedItems(manifest).find((item) => item.type === "Microsoft.Consumption/budgets");
  return {
    subscriptions: { main: mainSub, emptyNoBudget: emptySub },
    operations: [
      ...(budget?.properties?.budgetNames ?? []).map((budgetName) => ({
        phase: 0,
        itemId: budget.id,
        method: "DELETE",
        path: `/subscriptions/${mainSub}/providers/Microsoft.Consumption/budgets/${budgetName}`,
        apiVersion: API.budgets,
      })),
      { phase: 1, itemId: "rg-main", method: "DELETE", path: `/subscriptions/${mainSub}/resourceGroups/${config.resourceGroups.main}`, apiVersion: API.resourceGroups },
      {
        phase: 1,
        itemId: "rg-empty-no-budget",
        method: "DELETE",
        path: `/subscriptions/${emptySub}/resourceGroups/${config.resourceGroups["empty-no-budget"]}`,
        apiVersion: API.resourceGroups,
      },
    ],
    manual: [],
  };
}

/** Bearer token from env, else the signed-in az CLI. Null means skip. */
export function armToken(env = process.env, exec = defaultExec) {
  if (env.AZURE_ACCESS_TOKEN) {
    return env.AZURE_ACCESS_TOKEN;
  }
  try {
    const token = exec("az", ["account", "get-access-token", "--resource", `${ARM}/`, "--query", "accessToken", "-o", "tsv"]);
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function defaultExec(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export class ArmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ArmError";
    this.status = status;
  }
}

const TERMINAL = new Set(["Succeeded", "Failed", "Canceled"]);

/** One ARM call with long-running-operation polling. */
export async function armCall(operation, { token, fetchImpl = fetch, sleep = defaultSleep, pollMs = 5000, maxPolls = 360 }) {
  const url = `${ARM}${operation.path}?api-version=${operation.apiVersion}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const response = await fetchImpl(url, {
    method: operation.method,
    headers,
    ...(operation.body ? { body: JSON.stringify(operation.body) } : {}),
  });
  if (response.status >= 400) {
    const text = await response.text();
    throw new ArmError(`${operation.method} ${operation.path} failed ${response.status}: ${text.slice(0, 500)}`, response.status);
  }
  const poll = response.headers.get("azure-asyncoperation") ?? response.headers.get("location");
  if (response.status === 202 && poll) {
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      await sleep(pollMs);
      const status = await fetchImpl(poll, { method: "GET", headers });
      if (status.status >= 400) {
        throw new ArmError(`${operation.method} ${operation.path} poll failed ${status.status}`, status.status);
      }
      if (status.status === 202) {
        continue;
      }
      const body = await readJson(status);
      if (!body?.status || body.status === "Succeeded") {
        return { status: response.status, provisioningState: "Succeeded" };
      }
      if (TERMINAL.has(body.status)) {
        throw new ArmError(`${operation.method} ${operation.path} ended ${body.status}`, status.status);
      }
    }
    throw new ArmError(`${operation.method} ${operation.path} did not finish`, 202);
  }
  const body = await readJson(response);
  let state = body?.properties?.provisioningState;
  for (let attempt = 0; operation.method === "PUT" && state && !TERMINAL.has(state) && attempt < maxPolls; attempt += 1) {
    await sleep(pollMs);
    const current = await fetchImpl(url, { method: "GET", headers });
    state = (await readJson(current))?.properties?.provisioningState;
  }
  if (state && state !== "Succeeded") {
    throw new ArmError(`${operation.method} ${operation.path} provisioningState ${state}`, response.status);
  }
  return { status: response.status, provisioningState: state ?? null };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tenant rule and empty-subscription checks before any write. */
export async function preflight(config, plan, deps) {
  const errors = [];
  const tenantOf = async (subscriptionId) => {
    const response = await deps.fetchImpl(`${ARM}/subscriptions/${subscriptionId}?api-version=${API.subscriptions}`, {
      method: "GET",
      headers: { authorization: `Bearer ${deps.token}` },
    });
    if (response.status >= 400) {
      errors.push(`cannot read subscription ${subscriptionId} (${response.status})`);
      return null;
    }
    return (await readJson(response))?.tenantId ?? null;
  };
  for (const subscriptionId of [plan.subscriptions.main, plan.subscriptions.emptyNoBudget]) {
    if (subscriptionId.startsWith("<")) {
      continue;
    }
    const tenantId = await tenantOf(subscriptionId);
    if (tenantId && config.appRegistrationTenantId && tenantId === config.appRegistrationTenantId) {
      errors.push(`subscription ${subscriptionId} is in the app-registration tenant; the estate must sit in another tenant`);
    }
  }
  if (!plan.subscriptions.emptyNoBudget.startsWith("<")) {
    const response = await deps.fetchImpl(
      `${ARM}/subscriptions/${plan.subscriptions.emptyNoBudget}/providers/Microsoft.Consumption/budgets?api-version=${API.budgets}`,
      { method: "GET", headers: { authorization: `Bearer ${deps.token}` } },
    );
    const budgets = response.status < 400 ? ((await readJson(response))?.value ?? []) : [];
    if (budgets.length > 0) {
      errors.push(`empty-no-budget subscription has ${budgets.length} budget(s); it must have none`);
    }
  }
  return errors;
}

export function parseArgs(argv) {
  const args = { apply: false, destroy: false, createSubscriptions: false, config: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--destroy") args.destroy = true;
    else if (arg === "--create-subscriptions") args.createSubscriptions = true;
    else if (arg === "--config") args.config = argv[++index] ?? null;
    else if (arg === "--out") args.out = argv[++index] ?? null;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

/**
 * Entry point. Returns a record; never throws for missing credentials.
 * exitCode: 0 ok/skip/dry-run, 1 ARM or preflight failure, 2 apply with missing config.
 */
export async function runSeed({
  argv = [],
  env = process.env,
  manifest = loadManifest(),
  configFile = null,
  fetchImpl = fetch,
  exec = defaultExec,
  sleep = defaultSleep,
  now = new Date().toISOString(),
} = {}) {
  const args = parseArgs(argv);
  const file = configFile ?? (args.config ? JSON.parse(readFileSync(args.config, "utf8")) : null);
  const config = resolveConfig(env, file);
  args.createSubscriptions ||= config.create.enabled === true;
  const plan = args.createSubscriptions
    ? buildSubscriptionPlan(config)
    : args.destroy
      ? buildDestroyPlan(manifest, config)
      : buildSeedPlan(manifest, config, { now });
  const action = args.createSubscriptions ? "create-subscriptions" : args.destroy ? "destroy" : "seed";
  const base = {
    mode: args.apply ? "apply" : "dry-run",
    action,
    at: now,
    itemCount: seedItems(manifest).length,
    operations: plan.operations.map(({ itemId, method, path }) => ({ itemId, method, path })),
    manual: plan.manual,
  };
  if (!args.apply) {
    return { ...base, applied: false, skipped: false, exitCode: 0, reason: "Dry run. Pass --apply with credentials to call ARM." };
  }
  if (!config.subscriptions.main.subscriptionId && !args.createSubscriptions) {
    return { ...base, applied: false, skipped: true, exitCode: 0, reason: "AZURE_SUBSCRIPTION_ID is not set. Nothing applied (E1-S5-T1 leftover)." };
  }
  const token = armToken(env, exec);
  if (!token) {
    return { ...base, applied: false, skipped: true, exitCode: 0, reason: "No ARM token (AZURE_ACCESS_TOKEN unset and az CLI not signed in). Nothing applied." };
  }
  const missing = missingForApply(config, args);
  if (missing.length > 0) {
    return { ...base, applied: false, skipped: true, exitCode: 2, reason: `Apply refused; set: ${missing.join("; ")}` };
  }
  const deps = { token, fetchImpl, sleep };
  if (action === "seed") {
    const errors = await preflight(config, plan, deps);
    if (errors.length > 0) {
      return { ...base, applied: false, skipped: true, exitCode: 1, reason: `Preflight failed: ${errors.join("; ")}` };
    }
  }
  const results = [];
  for (const operation of plan.operations) {
    try {
      const result = await armCall(operation, deps);
      results.push({ itemId: operation.itemId, method: operation.method, path: operation.path, status: result.status });
    } catch (error) {
      results.push({ itemId: operation.itemId, method: operation.method, path: operation.path, error: String(error.message ?? error) });
      return { ...base, operations: results, applied: false, skipped: false, exitCode: 1, reason: `Stopped at ${operation.itemId}. Re-run is idempotent (PUT).` };
    }
  }
  return { ...base, operations: results, applied: true, skipped: false, exitCode: 0, reason: `${action}: applied ${results.length} ARM operations.` };
}

/** True when an apply would skip for want of the main subscription id. */
export function shouldSkipApply(env = process.env) {
  return !env.AZURE_SUBSCRIPTION_ID;
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isMain()) {
  let record;
  try {
    record = await runSeed({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  console.log(record.reason);
  console.log(`${record.mode} ${record.action}: ${record.operations.length} ARM operations, ${record.manual.length} manual steps, ${record.itemCount} seed items`);
  for (const operation of record.operations) {
    const outcome = operation.error ? ` ERROR ${operation.error}` : operation.status ? ` ${operation.status}` : "";
    console.log(`  ${operation.method.padEnd(6)} ${operation.path}${outcome}`);
  }
  for (const step of record.manual) {
    console.log(`  manual ${step.itemId}: ${step.step}`);
  }
  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`record written to ${args.out}`);
  }
  process.exit(record.exitCode);
}
