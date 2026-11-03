import { bool, defineGcpCheck, fail, nonEmptyStr, pass, str, undetermined } from "./checks/define.js";
import { SQL_TYPE } from "./gcp-support.js";
import { projectOf } from "./providers/gcp-scope.js";

export const GCP_SQL_HA_OR_BACKUP = "gcp-resilience-sql-ha-or-backup";
export const SQL_HA_TYPE = "REGIONAL";

export const checkGcpSqlHaOrBackup = defineGcpCheck({
  checkId: GCP_SQL_HA_OR_BACKUP,
  resourceType: SQL_TYPE,
  readFacts: (instance, fields) => ({
    instanceName: nonEmptyStr(fields, "instanceName") ?? instance.displayName,
    availabilityType: str(fields, "availabilityType"),
    backupEnabled: bool(fields, "backupEnabled"),
    projectId: nonEmptyStr(fields, "projectId") ?? projectOf(instance.resourceUri),
  }),
  decide: ({ instanceName, availabilityType, backupEnabled, projectId }, { resource }) => {
    const evidence = {
      resourceUri: resource.resourceUri,
      instanceName,
      availabilityType,
      backupEnabled,
      projectId,
    };
    if (availabilityType === null || backupEnabled === null) {
      return undetermined("A Cloud SQL instance read that includes both fields", evidence);
    }
    return availabilityType === SQL_HA_TYPE && backupEnabled ? pass(evidence) : fail(evidence);
  },
});
