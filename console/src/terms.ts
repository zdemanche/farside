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
