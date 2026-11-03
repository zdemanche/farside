import { OPTIONAL_AZURE_ROLES, REQUIRED_AZURE_ROLES } from "./roles.js";

export type GrantToRemove = {
  kind: "azure-role" | "admin-consent";
  name: string;
  optional?: boolean;
};

export type DeletionRecord = {
  orgId: string;
  deletedAt: string;
  connectionsRemoved: number;
  scansStopped: number;
  scheduleCancelled: boolean;
  accountClosureAt: string | null;
  trigger: "customer" | "retention";
};

export const GRANTS_TO_REMOVE: GrantToRemove[] = [
  ...REQUIRED_AZURE_ROLES.map((name) => ({ kind: "azure-role" as const, name })),
  ...OPTIONAL_AZURE_ROLES.map((name) => ({ kind: "azure-role" as const, name, optional: true })),
  {
    kind: "admin-consent",
    name: "Farside multi-tenant app registration",
  },
];

export function deletionView(record: DeletionRecord) {
  return {
    ...record,
    grantsToRemove: GRANTS_TO_REMOVE,
  };
}

export class DeletedOrgError extends Error {
  constructor(orgId: string) {
    super(`org ${orgId} has been deleted`);
    this.name = "DeletedOrgError";
  }
}
