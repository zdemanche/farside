export const PRODUCT_NAME = "Farside";

export const DEMO_LABEL = "Demo";

export const EMPTY_STATE =
  "Nothing to show yet. Connect a cloud estate to see inventory, issues, and cost.";

export const NOT_CONNECTED_STATE =
  "Not connected to a Farside API. Set VITE_FARSIDE_API_URL and VITE_FARSIDE_ORG to connect, or VITE_FARSIDE_DEMO=1 to view demo data.";

/** Planned console destinations from the proposal. Empty until later stories fill them. */
export const SHELL_NAV = [
  "Estate",
  "Connect",
  "Scans",
  "Settings",
  "Inventory",
  "Issues",
  "Cost and waste",
  "Lifecycle",
  "Recovery",
  "Blind spots",
] as const;
