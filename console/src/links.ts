export const inventoryHref = (resource: string): string =>
  `#inventory?resource=${encodeURIComponent(resource)}`;

export const scanHref = (id: string): string => `#scans/${encodeURIComponent(id)}`;

/** A server-supplied link is followed only when it stays inside the app (`#route`). */
export const isAppHref = (href: unknown): href is string =>
  typeof href === "string" && /^#[A-Za-z0-9]/.test(href);
