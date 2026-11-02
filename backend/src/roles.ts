export const REQUIRED_AZURE_ROLES = [
  "Reader",
  "Cost Management Reader",
  "Monitoring Reader",
  "Reservations Reader",
] as const;

export const OPTIONAL_AZURE_ROLES = ["Backup Reader"] as const;

export const CONNECT_STEPS = [
  "Confirm the Farside app registration is in a Moonaan-owned home tenant.",
  "Grant admin consent in the customer tenant.",
  "Assign the required read-only roles on the subscription.",
  "Enter the tenant id and subscription id. Farside never asks for a client secret.",
] as const;
