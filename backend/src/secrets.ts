const SECRET_KEY_PARTS = [
  "secret",
  "token",
  "password",
  "privatekey",
  "apikey",
  "authorization",
  "connectionstring",
  "accountkey",
];

const SECRET_VALUE = new RegExp(
  [
    "client_secret",
    "azure[_-]?client[_-]?secret",
    "(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{20,4096}\\.[A-Za-z0-9_-]{10,4096}",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "ya29\\.[A-Za-z0-9_-]{20,}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "[?&]sig=[A-Za-z0-9%+/=]{20,}",
    "(?<![A-Za-z0-9_.~-])[A-Za-z0-9_.~-]{3}\\dQ~[A-Za-z0-9_.~-]{31,}",
  ].join("|"),
  "i",
);

const SAS_KEYS = new Set(["sas", "sastoken", "sasurl", "sassignature"]);
const NON_SECRET_NUMBER_SUFFIXES = ["count", "total", "days", "hours", "limit"];

function isSecretKey(key: string, child: unknown): boolean {
  if (child == null || typeof child === "boolean") {
    return false;
  }
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  if (
    typeof child === "number" &&
    NON_SECRET_NUMBER_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return false;
  }
  return (
    SECRET_KEY_PARTS.some((part) => normalized.includes(part)) ||
    SAS_KEYS.has(normalized)
  );
}

export class SecretLeakError extends Error {
  constructor(path: string) {
    super(`secret or token pattern at ${path}`);
    this.name = "SecretLeakError";
  }
}

function walk(
  value: unknown,
  path: string,
  hits: string[],
  inTags = false,
): void {
  if (value == null) {
    return;
  }
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) {
      hits.push(path);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walk(item, `${path}[${index}]`, hits, inTags),
    );
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!inTags && isSecretKey(key, child)) {
      hits.push(childPath);
    }
    walk(child, childPath, hits, inTags || key.toLowerCase() === "tags");
  }
}

export function secretPaths(value: unknown): string[] {
  const hits: string[] = [];
  walk(value, "", hits);
  return hits;
}

export function assertNoSecrets(value: unknown): void {
  const hits = secretPaths(value);
  if (hits.length > 0) {
    throw new SecretLeakError(hits[0] ?? "");
  }
}
