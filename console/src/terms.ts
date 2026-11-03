export const TERMS = {
  assessed: "assessed",
  notAssessed: "not assessed",
  undetermined: "undetermined",
} as const;

export function coverageStateLabel(state: string): string {
  if (state === "assessed") {
    return TERMS.assessed;
  }
  if (state === "unassessed") {
    return TERMS.notAssessed;
  }
  return TERMS.undetermined;
}

export function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const SCAN_ERROR_TEXT: Record<string, string> = {
  harvest_failed: "Couldn't read the cloud estate",
  harvest_timeout: "The cloud estate didn't respond in time",
  scan_failed: "The scan failed",
};

export const scanErrorText = (code: string): string =>
  SCAN_ERROR_TEXT[code] ?? code;

export function shortName(resourceId: string): string {
  const isUri = resourceId.startsWith("/");
  return (isUri && resourceId.split("/").filter(Boolean).pop()) || resourceId;
}
