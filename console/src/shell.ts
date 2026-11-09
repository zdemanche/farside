export const PRODUCT_NAME = "Farside";

export const DEMO_LABEL = "Demo";

export const NOT_CONNECTED_STATE =
  "Not connected to a Farside API. Set VITE_FARSIDE_API_URL and VITE_FARSIDE_ORG to connect, or VITE_FARSIDE_DEMO=1 to view demo data.";

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
  "Billing",
  "Offboarding",
] as const;

/** Screens shown in place of the navigation when sign-in is configured (#49). */
export const SIGN_IN_TITLE = "Sign in";
export const CLAIM_TITLE = "Claim your organisation";
export const JOIN_TITLE = "Join your organisation";

export const slugOf = (item: string): string => item.toLowerCase().replaceAll(" ", "-");
