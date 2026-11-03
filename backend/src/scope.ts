import type { Cloud } from "@farside/scan-contracts";
import { projectOf } from "./gcp-inventory.js";

/** Azure ARM `/subscriptions/{id}/…`. Index 2 is the subscription, not a GCP project. */
export function subscriptionOf(resourceUri: string): string {
  return resourceUri.split("/")[2] ?? "";
}

/** Subscription on Azure ARM ids; Cloud Asset `projects` segment on GCP. */
export function scopeOf(cloud: Cloud, resourceUri: string): string {
  return cloud === "gcp" ? projectOf(resourceUri) : subscriptionOf(resourceUri);
}
