export type DataErrorKind =
  "unauthenticated" | "denied" | "gone" | "not-found" | "network" | "failed";

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

const KIND_BY_STATUS: Record<number, DataErrorKind> = {
  401: "unauthenticated",
  403: "denied",
  404: "not-found",
  410: "gone",
};

export function errorFromStatus(status: number, title: string): DataError {
  return new DataError(KIND_BY_STATUS[status] ?? "failed", status, `${status} ${title}`.trim());
}

export function toDataError(error: unknown): DataError {
  if (error instanceof DataError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return new DataError("network", null, message);
}

export function isRetryable(error: DataError): boolean {
  return error.kind !== "unauthenticated" && error.kind !== "denied" && error.kind !== "gone";
}

export function failureMessage(error: DataError, action: string): string {
  switch (error.kind) {
    case "unauthenticated":
      return `Not signed in. Sign in to ${action}.`;
    case "denied":
      return `This session doesn't have access to this organisation, so you cannot ${action}.`;
    case "gone":
      return "This organisation has been deleted.";
    case "network":
      return `Could not reach the Farside API to ${action}.`;
    default:
      return `Could not ${action}: ${error.message}`;
  }
}
