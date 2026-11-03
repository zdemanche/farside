export type DataErrorKind = "denied" | "not-found" | "network" | "failed";

export const ROLE_READ = "Farside Reader";
export const ROLE_WRITE = "Farside Admin";

export class DataError extends Error {
  readonly kind: DataErrorKind;
  readonly status: number | null;

  constructor(kind: DataErrorKind, status: number | null, message: string) {
    super(message);
    this.name = "DataError";
    this.kind = kind;
    this.status = status;
  }
}

export function errorFromStatus(status: number, title: string): DataError {
  const kind: DataErrorKind =
    status === 401 || status === 403 ? "denied" : status === 404 ? "not-found" : "failed";
  return new DataError(kind, status, `${status} ${title}`.trim());
}

export function toDataError(error: unknown): DataError {
  if (error instanceof DataError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return new DataError("network", null, message);
}

export function failureMessage(error: DataError, action: string, role: string = ROLE_READ): string {
  if (error.kind === "denied") {
    return `You do not have permission to ${action}. Ask your Farside administrator for the ${role} role.`;
  }
  if (error.kind === "network") {
    return `Could not reach the Farside API to ${action}.`;
  }
  return `Could not ${action}: ${error.message}`;
}
