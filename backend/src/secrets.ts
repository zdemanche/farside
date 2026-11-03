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
    "eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "ya29\\.[A-Za-z0-9_-]{20,}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "[?&]sig=[A-Za-z0-9%+/=]{20,}",
    "\\b[A-Za-z0-9]{3}\\dQ~[A-Za-z0-9_.~-]{30,}",
  ].join("|"),
  "i",
);

function isSecretKey(key: string, child: unknown): boolean {
  if (
    child == null ||
    typeof child === "number" ||
    typeof child === "boolean"
  ) {
    return false;
  }
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return (
    SECRET_KEY_PARTS.some((part) => normalized.includes(part)) ||
    normalized.startsWith("sas") ||
    normalized.endsWith("sas")
  );
}

export class SecretLeakError extends Error {
  constructor(path: string) {
    super(`secret or token pattern at ${path}`);
    this.name = "SecretLeakError";
  }
}

function walk(value: unknown, path: string, hits: string[]): void {
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
    value.forEach((item, index) => walk(item, `${path}[${index}]`, hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isSecretKey(key, child)) {
      hits.push(childPath);
    }
    walk(child, childPath, hits);
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
