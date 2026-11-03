import { bool, defineAzureCheck, fail, pass, str, undetermined } from "./define.js";
import type { OrgSettings } from "../settings.js";

export const PROD_VM_BACKUP = "azure-resilience-prod-vms-outside-backup";
export const PROD_SQL_BACKUP = "azure-resilience-prod-sql-outside-backup";
export const DB_ZONE_OR_GEO = "azure-resilience-db-zone-or-geo";

const MARKER_CLOSER = "Set the production tag or name pattern in Settings";

function configuredMarker(settings: OrgSettings): string | null {
  if (settings.productionTagKey.length === 0 || settings.productionTagValue.length === 0) {
    return null;
  }
  return `${settings.productionTagKey}=${settings.productionTagValue}`;
}

function productionBackupCheck(spec: {
  checkId: string;
  resourceType: string;
  idField: "vmId" | "sqlResourceId";
  roleCloser: string;
}) {
  return defineAzureCheck({
    checkId: spec.checkId,
    resourceType: spec.resourceType,
    select: (resources, { settings }) =>
      configuredMarker(settings)
        ? resources.filter((resource) => resource.tags[settings.productionTagKey] === settings.productionTagValue)
        : resources,
    prepare: (production, { rows, settings }) => ({
      marker: configuredMarker(settings),
      productionCount: production.length,
      unprotectedCount: production.filter(
        (resource) => rows.get(resource.resourceUri)?.fields.protected === false,
      ).length,
    }),
    readFacts: (resource, fields) => ({
      id: str(fields, spec.idField) ?? resource.displayName,
      vaultId: str(fields, "vaultId"),
      protectedState: bool(fields, "protected"),
    }),
    decide: ({ id, vaultId, protectedState }, { resource, shared }) => {
      const { marker, productionCount, unprotectedCount } = shared;
      const evidence = (state: boolean | null, vault: string | null) => ({
        resourceUri: resource.resourceUri,
        [spec.idField]: id,
        productionMarker: marker,
        vaultId: vault,
        protected: state,
      });
      if (!marker) {
        return undetermined(MARKER_CLOSER, evidence(null, null));
      }
      if (protectedState === null) {
        return undetermined(spec.roleCloser, evidence(null, vaultId));
      }
      return protectedState
        ? pass({ ...evidence(true, vaultId), productionCount })
        : fail({ ...evidence(false, vaultId), unprotectedCount, productionCount });
    },
  });
}

export const checkProdVmBackup = productionBackupCheck({
  checkId: PROD_VM_BACKUP,
  resourceType: "Microsoft.Compute/virtualMachines",
  idField: "vmId",
  roleCloser: "Backup Reader on the vaults in scope",
});

export const checkProdSqlBackup = productionBackupCheck({
  checkId: PROD_SQL_BACKUP,
  resourceType: "Microsoft.Sql/servers/databases",
  idField: "sqlResourceId",
  roleCloser: "Backup Reader on the relevant vaults and a list of SQL backup items",
});

export const checkDbZoneOrGeo = defineAzureCheck({
  checkId: DB_ZONE_OR_GEO,
  resourceType: "Microsoft.Sql/servers/databases",
  readFacts: (database, fields) => ({
    databaseId: str(fields, "databaseId") ?? database.displayName,
    engine: str(fields, "engine"),
    zoneRedundant: bool(fields, "zoneRedundant"),
    backupRedundancy: str(fields, "backupRedundancy"),
  }),
  decide: ({ databaseId, engine, zoneRedundant, backupRedundancy }, { resource: database }) => {
    const evidence = { resourceUri: database.resourceUri, databaseId, engine, zoneRedundant, backupRedundancy };
    if (zoneRedundant === null || backupRedundancy === null) {
      return undetermined("A database read that includes those properties for that engine", evidence);
    }
    const missing = [
      zoneRedundant ? null : "zone redundancy",
      /geo/i.test(backupRedundancy) ? null : "geo-backup",
    ].filter((item): item is string => item !== null);
    return missing.length > 0 ? fail({ ...evidence, missingSetting: missing.join(" and ") }) : pass(evidence);
  },
});
