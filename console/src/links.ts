export const inventoryHref = (resource: string): string =>
  `#inventory?resource=${encodeURIComponent(resource)}`;

export const scanHref = (id: string): string => `#scans/${encodeURIComponent(id)}`;
