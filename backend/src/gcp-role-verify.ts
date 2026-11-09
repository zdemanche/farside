import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import gcpSpec from "../../docs/gcp/launch-checks.json" with { type: "json" };
import {
  GcpLiveConfigError,
  gcpLiveClients,
  gcpLiveConfigFromEnv,
  type GcpLiveDeps,
} from "./gcp-live-harvester.js";
import type { GcpPermissionTester } from "./gcp-live.js";
import { probeRoles, type RoleLister } from "./role-probe.js";
import { assertNoSecrets } from "./secrets.js";

/**
 * Proves the GCP role list in docs/gcp/launch-checks.json with testIamPermissions: a role
 * counts as granted only when every permission the built readers use for it is granted.
 */
export type RolePermissions = { project: readonly string[]; table?: readonly string[] };

export const ROLE_PERMISSIONS: Record<string, RolePermissions> = {
  "Cloud Asset Viewer": { project: ["cloudasset.assets.listResource"] },
  "Compute Viewer": {
    project: [
      "compute.disks.list",
      "compute.addresses.list",
      "compute.snapshots.list",
      "compute.images.list",
      "compute.instances.list",
    ],
  },
  "Recommender Viewer": {
    project: [
      "recommender.computeInstanceIdleResourceRecommendations.list",
      "recommender.computeDiskIdleResourceRecommendations.list",
    ],
  },
  "Cloud SQL Viewer": { project: ["cloudsql.instances.list"] },
  "Certificate Manager Viewer": { project: ["certificatemanager.certs.list"] },
  "BigQuery access to the billing export": {
    project: ["bigquery.jobs.create"],
    table: ["bigquery.tables.getData"],
  },
};

/** Permissions a built reader needs that no spec role names. Reported, not silently added. */
export const UNNAMED_PERMISSIONS = [
  {
    permission: "container.clusters.list",
    reader: "GKE version read for gcp-lifecycle-sql-gke-support",
    suggestedRole: "Kubernetes Engine Cluster Viewer",
  },
] as const;

export const ROLE_RUN_KIND = "gcp-role-verification";

export type RoleResult = {
  role: string;
  permissions: string[];
  granted: string[];
  missing: string[];
  verified: boolean;
  note?: string;
};

export type RoleRunRecord = {
  kind: typeof ROLE_RUN_KIND;
  cloud: "gcp";
  liveRunAt: string;
  startedAt: string;
  projectId: string;
  billingTable: string | null;
  roles: RoleResult[];
  unnamedPermissions: Array<{
    permission: string;
    granted: boolean;
    reader: string;
    suggestedRole: string;
  }>;
  healthy: boolean;
  missingRequiredRoles: string[];
};

export function specRoleList(): string[] {
  return [...(gcpSpec as { rolesFromProposal: string[] }).rolesFromProposal];
}

export async function verifyGcpRoles(input: {
  projectId: string;
  tester: GcpPermissionTester;
  billingTable?: string;
  now?: () => Date;
}): Promise<RoleRunRecord> {
  const started = (input.now ?? (() => new Date()))();
  const roles = specRoleList();
  const unknown = roles.filter((role) => !ROLE_PERMISSIONS[role]);
  if (unknown.length > 0) {
    throw new Error(`no permission map for spec role(s): ${unknown.join(", ")}`);
  }
  const projectPermissions = [
    ...new Set([
      ...roles.flatMap((role) => ROLE_PERMISSIONS[role]?.project ?? []),
      ...UNNAMED_PERMISSIONS.map((item) => item.permission),
    ]),
  ];
  const tablePermissions = [
    ...new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]?.table ?? [])),
  ];
  const grantedProject = new Set(await input.tester.project(input.projectId, projectPermissions));
  const grantedTable = new Set(
    input.billingTable && tablePermissions.length > 0
      ? await input.tester.table(input.billingTable, tablePermissions)
      : [],
  );
  const results: RoleResult[] = roles.map((role) => {
    const map = ROLE_PERMISSIONS[role] as RolePermissions;
    const permissions = [...map.project, ...(map.table ?? [])];
    const granted = [
      ...map.project.filter((permission) => grantedProject.has(permission)),
      ...(map.table ?? []).filter((permission) => grantedTable.has(permission)),
    ];
    const missing = permissions.filter((permission) => !granted.includes(permission));
    const untested = map.table && !input.billingTable;
    return {
      role,
      permissions,
      granted,
      missing,
      verified: missing.length === 0,
      ...(untested ? { note: "Billing export table not configured; table read not tested" } : {}),
    };
  });
  const probe = probeRoles(
    "gcp",
    results.filter((result) => result.verified).map((result) => result.role),
  );
  const record: RoleRunRecord = {
    kind: ROLE_RUN_KIND,
    cloud: "gcp",
    liveRunAt: started.toISOString().slice(0, 10),
    startedAt: started.toISOString(),
    projectId: input.projectId,
    billingTable: input.billingTable ?? null,
    roles: results,
    unnamedPermissions: UNNAMED_PERMISSIONS.map((item) => ({
      permission: item.permission,
      granted: grantedProject.has(item.permission),
      reader: item.reader,
      suggestedRole: item.suggestedRole,
    })),
    healthy: probe.healthy,
    missingRequiredRoles: probe.missingRoles.filter((gap) => gap.required).map((gap) => gap.role),
  };
  assertNoSecrets(record);
  return record;
}

/** RoleLister backed by testIamPermissions, for the connect role probe. */
export function gcpPermissionRoleLister(
  tester: GcpPermissionTester,
  billingTable?: string,
): RoleLister {
  return {
    async list(input) {
      const record = await verifyGcpRoles({
        projectId: input.subscriptionId,
        tester,
        ...(billingTable ? { billingTable } : {}),
      });
      return record.roles.filter((role) => role.verified).map((role) => role.role);
    },
  };
}

export const LIVE_RUNS_DIR = fileURLToPath(new URL("../../docs/gcp/live-runs/", import.meta.url));

export function writeRunRecord(dir: string, name: string, record: object): string {
  assertNoSecrets(record);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export type MainIo = {
  env?: NodeJS.Dict<string>;
  deps?: GcpLiveDeps;
  out?: (line: string) => void;
  dir?: string;
};

export async function main(io: MainIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  let config;
  try {
    config = gcpLiveConfigFromEnv(io.env ?? process.env);
  } catch (error) {
    if (error instanceof GcpLiveConfigError) {
      out(error.message);
      return 1;
    }
    throw error;
  }
  if (!config) {
    out("skipped: no GCP credentials");
    return 0;
  }
  const clients = gcpLiveClients(config, io.deps);
  const record = await verifyGcpRoles({
    projectId: config.projectId,
    tester: clients.permissions,
    ...(config.billingTable ? { billingTable: config.billingTable } : {}),
    ...(io.deps?.now ? { now: io.deps.now } : {}),
  });
  const path = writeRunRecord(
    io.dir ?? LIVE_RUNS_DIR,
    `${record.liveRunAt}-${record.projectId}-roles.json`,
    record,
  );
  out(`role run record: ${path}`);
  out(
    `healthy: ${record.healthy}; missing required roles: ${record.missingRequiredRoles.join(", ") || "none"}`,
  );
  return record.healthy ? 0 : 1;
}

function isMain(): boolean {
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
  process.exitCode = await main();
}
