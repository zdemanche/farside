import type { Cloud } from "@farside/scan-contracts";
import { providerFor } from "./providers/index.js";

export { subscriptionOf } from "./providers/arm.js";

export function scopeOf(cloud: Cloud, resourceUri: string): string {
  return providerFor(cloud).scopeOf(resourceUri);
}
