export function projectOf(resourceUri: string): string {
  const parts = resourceUri.split("/");
  const index = parts.indexOf("projects");
  const project = index >= 0 ? parts[index + 1] : undefined;
  return typeof project === "string" ? project : "";
}
