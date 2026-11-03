export function subscriptionOf(resourceUri: string): string {
  return resourceUri.split("/")[2] ?? "";
}
