export type RecoveryRow = {
  id: string;
  system: string;
  checkId: string;
  evidence: string;
  coverage: "assessed" | "undetermined";
};

export const RECOVERY_BACKUP = { unprotected: 2, production: 4 };

export const RECOVERY_ROWS: RecoveryRow[] = [
  {
    id: "vm-prod-no-backup",
    system: "vm-prod-no-backup",
    checkId: "azure-resilience-prod-vms-outside-backup",
    evidence: "protected false, productionMarker environment=prod, 1 of 2",
    coverage: "assessed",
  },
  {
    id: "sql-prod-no-backup",
    system: "sql-prod-no-backup",
    checkId: "azure-resilience-prod-sql-outside-backup",
    evidence: "protected false, productionMarker environment=prod, 1 of 2",
    coverage: "assessed",
  },
  {
    id: "db-no-zone-geo",
    system: "db-no-zone-geo",
    checkId: "azure-resilience-db-zone-or-geo",
    evidence: "zoneRedundant false, backupRedundancy Local, missing zone redundancy and geo-backup",
    coverage: "assessed",
  },
];
