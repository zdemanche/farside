import { CLOUDS, FINDING_RESULTS, RAW_PROVIDER_KEYS, type Finding, type Inventory } from "./types.js";

export type ValidationError = { path: string; message: string };

const RAW_KEY_SET = new Set<string>(RAW_PROVIDER_KEYS);

function walkForbidden(value: unknown, path: string, errors: ValidationError[]): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForbidden(item, `${path}[${index}]`, errors));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (RAW_KEY_SET.has(key)) {
      errors.push({
        path: childPath,
        message: "raw provider payload fields are rejected; store aggregates only",
      });
    }
    walkForbidden(child, childPath, errors);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimalString(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value);
}

export function validateFinding(input: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  walkForbidden(input, "", errors);
  if (!isRecord(input)) {
    return [{ path: "", message: "finding must be an object" }, ...errors];
  }
  if (typeof input.checkId !== "string" || input.checkId.length === 0) {
    errors.push({ path: "checkId", message: "required string" });
  }
  if (!FINDING_RESULTS.includes(input.result as Finding["result"])) {
    errors.push({ path: "result", message: "must be pass, fail, or undetermined" });
  }
  if (!isRecord(input.scope)) {
    errors.push({ path: "scope", message: "required object" });
  } else {
    if (typeof input.scope.id !== "string" || input.scope.id.length === 0) {
      errors.push({ path: "scope.id", message: "required string" });
    }
    if (!CLOUDS.includes(input.scope.cloud as Finding["scope"]["cloud"])) {
      errors.push({ path: "scope.cloud", message: "must be azure or gcp" });
    }
    if (
      typeof input.scope.subscriptionOrProject !== "string" ||
      input.scope.subscriptionOrProject.length === 0
    ) {
      errors.push({ path: "scope.subscriptionOrProject", message: "required string" });
    }
  }
  if (!isRecord(input.evidence) || !isRecord(input.evidence.fields)) {
    errors.push({ path: "evidence.fields", message: "finding without evidence fails validation" });
  } else if (Object.keys(input.evidence.fields).length === 0) {
    errors.push({ path: "evidence.fields", message: "finding without evidence fails validation" });
  }
  if (input.result === "undetermined") {
    if (typeof input.closer !== "string" || input.closer.trim().length === 0) {
      errors.push({
        path: "closer",
        message: "undetermined results must say what would close them",
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "savings")) {
    if (typeof input.savings === "number") {
      errors.push({ path: "savings", message: "single point value is rejected; use a min/max range" });
    } else if (!isRecord(input.savings)) {
      errors.push({ path: "savings", message: "savings must be a { min, max, currency } range" });
    } else if (Object.prototype.hasOwnProperty.call(input.savings, "amount")) {
      errors.push({ path: "savings.amount", message: "single point value is rejected; use a min/max range" });
    } else if (!decimalString(input.savings.min) || !decimalString(input.savings.max)) {
      errors.push({ path: "savings", message: "min and max must be decimal strings" });
    } else if (Number(input.savings.min) > Number(input.savings.max)) {
      errors.push({ path: "savings", message: "min must be <= max" });
    } else if (typeof input.savings.currency !== "string" || input.savings.currency.length === 0) {
      errors.push({ path: "savings.currency", message: "required string" });
    }
  }
  return errors;
}

export function validateInventory(input: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  walkForbidden(input, "", errors);
  if (!isRecord(input)) {
    return [{ path: "", message: "inventory must be an object" }, ...errors];
  }
  if (!CLOUDS.includes(input.cloud as Inventory["cloud"])) {
    errors.push({ path: "cloud", message: "must be azure or gcp" });
  }
  if (typeof input.observedAt !== "string" || input.observedAt.length === 0) {
    errors.push({ path: "observedAt", message: "required string" });
  }
  if (!Array.isArray(input.resources)) {
    errors.push({ path: "resources", message: "required array" });
    return errors;
  }
  input.resources.forEach((resource, index) => {
    if (!isRecord(resource)) {
      errors.push({ path: `resources[${index}]`, message: "must be an object" });
      return;
    }
    for (const field of ["resourceUri", "resourceType", "region", "displayName"] as const) {
      if (typeof resource[field] !== "string" || resource[field].length === 0) {
        errors.push({ path: `resources[${index}].${field}`, message: "required string" });
      }
    }
    if (!isRecord(resource.tags)) {
      errors.push({ path: `resources[${index}].tags`, message: "required object of strings" });
    }
  });
  return errors;
}

export function validateCoverage(input: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  walkForbidden(input, "", errors);
  if (!isRecord(input) || !Array.isArray(input.scopes)) {
    return [{ path: "scopes", message: "coverage.scopes must be an array" }, ...errors];
  }
  input.scopes.forEach((scope, index) => {
    if (!isRecord(scope)) {
      errors.push({ path: `scopes[${index}]`, message: "must be an object" });
      return;
    }
    if (typeof scope.id !== "string" || scope.id.length === 0) {
      errors.push({ path: `scopes[${index}].id`, message: "required string" });
    }
    if (typeof scope.checkId !== "string" || scope.checkId.length === 0) {
      errors.push({ path: `scopes[${index}].checkId`, message: "required string" });
    }
    if (typeof scope.assessed !== "boolean") {
      errors.push({ path: `scopes[${index}].assessed`, message: "required boolean" });
    }
  });
  return errors;
}

export function assertValid(errors: ValidationError[]): void {
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `${error.path}: ${error.message}`).join("; "));
  }
}
