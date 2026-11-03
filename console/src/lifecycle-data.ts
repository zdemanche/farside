export type LifecycleRow = {
  id: string;
  date: string;
  kind: string;
  title: string;
  source: string;
};

export const LIFECYCLE_WITHIN_90 = 3;

export const LIFECYCLE_ROWS: LifecycleRow[] = [
  {
    id: "cert-app-expiring",
    date: "2026-11-22",
    kind: "certificate",
    title: "cert-app-expiring",
    source: "App Service certificate expiry",
  },
  {
    id: "cert-gateway-expiring",
    date: "2026-11-22",
    kind: "certificate",
    title: "cert-gateway-expiring",
    source: "Gateway certificate expiry",
  },
  {
    id: "vm-retiring-sku",
    date: "2026-12-31",
    kind: "sku",
    title: "Standard_B1ls",
    source: "docs/azure/retiring-skus.json",
  },
];
