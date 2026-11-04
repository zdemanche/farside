import type { Cloud } from "@farside/scan-contracts";
import { missingRoles, type RoleGap } from "./cli-credentials.js";
import { providerFor } from "./providers/index.js";

export type RoleLister = {
  list: (input: { tenantId: string; subscriptionId: string; cloud: Cloud }) => Promise<string[]>;
};

export type RoleProbe = {
  roles: string[];
  missingRoles: RoleGap[];
  healthy: boolean;
};

export function presentRoles(cloud: Cloud): string[] {
  const provider = providerFor(cloud);
  return [...provider.requiredRoles, ...provider.optionalRoles];
}

export function defaultRoleLister(): RoleLister {
  return {
    async list(input) {
      return presentRoles(input.cloud);
    },
  };
}

export function grantedRoleLister(roles: readonly string[]): RoleLister {
  return {
    async list() {
      return [...roles];
    },
  };
}

export function mutableRoleLister(roles: readonly string[]): RoleLister & { grant: (next: readonly string[]) => void } {
  let granted = [...roles];
  return {
    grant(next) {
      granted = [...next];
    },
    async list() {
      return [...granted];
    },
  };
}

export function probeRoles(cloud: Cloud, granted: readonly string[]): RoleProbe {
  const missing = missingRoles(cloud, granted);
  return {
    roles: [...granted],
    missingRoles: missing,
    healthy: !missing.some((gap) => gap.required),
  };
}
