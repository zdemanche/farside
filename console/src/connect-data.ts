export const REQUIRED_AZURE_ROLES = [
  "Reader",
  "Cost Management Reader",
  "Monitoring Reader",
  "Reservations Reader",
] as const;

export const CONNECT_STEPS = [
  "Confirm the Farside app registration is in a Moonaan-owned home tenant.",
  "Grant admin consent in the customer tenant.",
  "Assign the required read-only roles on the subscription.",
  "Enter the tenant id and subscription id. Farside never asks for a client secret.",
] as const;

/**
 * GCP roles come from docs/gcp/launch-checks.json (rolesFromProposal). They have not been
 * verified against a live project, so the screen says so.
 */
export const REQUIRED_GCP_ROLES = [
  "Cloud Asset Viewer",
  "Compute Viewer",
  "Recommender Viewer",
  "Cloud SQL Viewer",
  "Certificate Manager Viewer",
] as const;

export const OPTIONAL_GCP_ROLES = ["BigQuery access to the billing export"] as const;

export const GCP_CONNECT_STEPS = [
  "Set up federated access for Farside with workload identity federation. Farside never asks for a service account key.",
  "Grant the required read-only roles on the project.",
  "Enable the BigQuery billing export to read cost. Without it, cost checks are not assessed.",
  "Enter the organization id and project id.",
] as const;
