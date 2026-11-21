/**
 * The safe fields of a failed read, for a log line or a coverage note: the error's name and, when it has them, a numeric
 * status, a short code (an AADSTS or Google error code) and a federation step. Never the message, a URL or a body.
 */
export type ErrorDetail = { name: string; status?: number; code?: string; step?: string };

const SAFE_TOKEN = /^[A-Za-z0-9_:.-]{1,64}$/;

export function errorDetail(error: unknown): ErrorDetail {
  if (typeof error !== "object" || error === null) {
    return { name: "UnknownError" };
  }
  const fields = error as { name?: unknown; status?: unknown; code?: unknown; step?: unknown };
  const token = (value: unknown) =>
    typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
  const name = token(fields.name) ?? "Error";
  const code = token(fields.code);
  const step = token(fields.step);
  return {
    name,
    ...(typeof fields.status === "number" && Number.isFinite(fields.status)
      ? { status: fields.status }
      : {}),
    ...(code ? { code } : {}),
    ...(step ? { step } : {}),
  };
}
