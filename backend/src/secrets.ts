const SECRET_KEY =
  /^(client_secret|clientsecret|access_token|refresh_token|id_token|password|secret|api[_-]?key)$/i;

const SECRET_VALUE =
  /(client_secret|azure[_-]?client[_-]?secret|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/i;

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
    if (SECRET_KEY.test(key)) {
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
