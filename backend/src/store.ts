import type { Finding, Inventory } from "@farside/scan-contracts";
import type { CoverageEntry } from "./coverage.js";
import type { ResourceFacts } from "./facts.js";
import { applyOwnerTag } from "./inventory.js";
import { REQUIRED_AZURE_ROLES } from "./roles.js";
import type { ScanJob } from "./scans.js";
import { assertNoSecrets } from "./secrets.js";
import { DEFAULT_SETTINGS, type OrgSettings } from "./settings.js";

export type Connection = {
  id: string;
  tenantId: string;
  subscriptionId: string;
  roles: string[];
  createdAt: string;
};

export type OrgState = {
  connections: Connection[];
  inventory: Inventory | null;
  coverage: CoverageEntry[];
  findings: Finding[];
  settings: OrgSettings;
  scans: ScanJob[];
  facts: ResourceFacts[];
};

function emptyOrg(): OrgState {
  return {
    connections: [],
    inventory: null,
    coverage: [],
    findings: [],
    settings: { ...DEFAULT_SETTINGS },
    scans: [],
    facts: [],
  };
}

export class MemoryStore {
  #orgs = new Map<string, OrgState>();

  org(orgId: string): OrgState {
    const existing = this.#orgs.get(orgId);
    if (existing) {
      return existing;
    }
    const created = emptyOrg();
    this.#orgs.set(orgId, created);
    return created;
  }

  snapshot(orgId: string): OrgState {
    const copy = structuredClone(this.org(orgId));
    assertNoSecrets(copy);
    return copy;
  }

  putInventory(orgId: string, inventory: Inventory): Inventory {
    assertNoSecrets(inventory);
    this.org(orgId).inventory = inventory;
    return inventory;
  }

  putConnection(
    orgId: string,
    input: { tenantId: string; subscriptionId: string },
  ): Connection {
    assertNoSecrets(input);
    const connection: Connection = {
      id: `conn-${this.org(orgId).connections.length + 1}`,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      roles: [...REQUIRED_AZURE_ROLES],
      createdAt: "1970-01-01T00:00:00.000Z",
    };
    this.org(orgId).connections.push(connection);
    return connection;
  }

  putCoverage(orgId: string, coverage: CoverageEntry[]): CoverageEntry[] {
    assertNoSecrets(coverage);
    this.org(orgId).coverage = coverage;
    return coverage;
  }

  putFindings(orgId: string, findings: Finding[]): Finding[] {
    assertNoSecrets(findings);
    this.org(orgId).findings = findings;
    return findings;
  }

  putFacts(orgId: string, facts: ResourceFacts[]): ResourceFacts[] {
    assertNoSecrets(facts);
    this.org(orgId).facts = facts;
    return facts;
  }

  putSettings(orgId: string, settings: OrgSettings): OrgSettings {
    assertNoSecrets(settings);
    const org = this.org(orgId);
    org.settings = settings;
    if (org.inventory) {
      org.inventory = applyOwnerTag(org.inventory, settings.ownerTagKey);
    }
    return settings;
  }

  putJob(input: Omit<ScanJob, "id">): ScanJob {
    assertNoSecrets(input);
    const job: ScanJob = { ...input, id: `scan-${this.org(input.orgId).scans.length + 1}` };
    this.org(input.orgId).scans.push(job);
    return job;
  }

  getJob(orgId: string, jobId: string): ScanJob | undefined {
    return this.org(orgId).scans.find((job) => job.id === jobId);
  }

  patchJob(orgId: string, jobId: string, patch: Partial<ScanJob>): ScanJob {
    const org = this.org(orgId);
    const index = org.scans.findIndex((job) => job.id === jobId);
    const current = org.scans[index];
    if (index < 0 || !current) {
      throw new Error(`scan ${jobId} missing`);
    }
    const next = { ...current, ...patch, id: current.id, orgId: current.orgId };
    assertNoSecrets(next);
    org.scans[index] = next;
    return next;
  }

  runningScan(orgId: string, subscriptionId: string): ScanJob | undefined {
    return this.org(orgId).scans.find(
      (job) =>
        job.subscriptionId === subscriptionId &&
        (job.status === "queued" || job.status === "running"),
    );
  }

  deleteConnection(orgId: string, connectionId: string): boolean {
    const org = this.org(orgId);
    const next = org.connections.filter((connection) => connection.id !== connectionId);
    if (next.length === org.connections.length) {
      return false;
    }
    org.connections = next;
    return true;
  }
}
