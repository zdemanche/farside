import { applyCoverageResults, recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { addAmounts, CrossCurrencyError, totalSameCurrency } from "./cost.js";
import { GCP_TEST_PROJECT } from "./gcp-inventory.js";
import { rejectUnconfigured } from "./providers/unconfigured.js";
import docGcpAlertReplay from "../../docs/gcp/alert-replay.json" with { type: "json" };

export const GCP_SPEND_BY_SERVICE = "gcp-cost-spend-by-service";
export const GCP_COST_ROLE_CLOSER = "BigQuery access to the billing export";
export const GCP_COST_PAGE_LIMIT = 50;

export const GCP_COST_HARVEST_UNVERIFIED = {
  harvestStatus: "unverified",
  liveRunAt: null,
  harvestStatusReason:
    "Fixture export rows are not billed months from a live project. A console comparison stays leftover.",
} as const;

export type GcpCostRow = {
  date: string;
  projectId: string;
  serviceName: string;
  costAmount: string;
  currency: string;
};

export type GcpCostPage = {
  rows: GcpCostRow[];
  pageToken?: string;
};

export type BigQueryExportClient = {
  query: (input: { projectId: string; pageToken?: string }) => Promise<GcpCostPage>;
};

export type GcpCostAggregate = {
  projectId: string;
  serviceName: string;
  costAmount: string;
  currency: string;
};

export type GcpCostSnapshot = {
  projectId: string;
  currency: string;
  asOf: string;
  services: GcpCostAggregate[];
  harvestStatus: "unverified";
  liveRunAt: null;
  harvestStatusReason: string;
};

export type GcpCostHarvestResult =
  | { ok: true; snapshot: GcpCostSnapshot; coverage: CoverageEntry[] }
  | { ok: false; reason: "missing_role" | "mixed_currency"; coverage: CoverageEntry[] };

export class MissingBillingExportRoleError extends Error {
  constructor() {
    super("BigQuery access to the billing export is missing");
    this.name = "MissingBillingExportRoleError";
  }
}

type ReplayFile = { rows: GcpCostRow[] };

const REPLAY = docGcpAlertReplay as ReplayFile;

export function fixtureBigQueryExportClient(options?: {
  rows?: readonly GcpCostRow[];
  pageSize?: number;
}): BigQueryExportClient {
  const rows = options?.rows ?? REPLAY.rows;
  const pageSize = options?.pageSize ?? 8;
  return {
    async query(input) {
      const matching = rows.filter((row) => row.projectId === input.projectId);
      const offset = input.pageToken ? Number(input.pageToken) : 0;
      if (!Number.isFinite(offset) || offset < 0) {
        return { rows: [] };
      }
      const page = matching.slice(offset, offset + pageSize);
      const next = offset + pageSize;
      return next < matching.length ? { rows: page, pageToken: String(next) } : { rows: page };
    },
  };
}

export function unconfiguredBigQueryExportClient(): BigQueryExportClient {
  return {
    async query() {
      rejectUnconfigured();
    },
  };
}

export function missingBillingExportRoleClient(): BigQueryExportClient {
  return {
    async query() {
      throw new MissingBillingExportRoleError();
    },
  };
}

export function fixtureGcpCostRows(projectId = GCP_TEST_PROJECT): GcpCostRow[] {
  return REPLAY.rows.filter((row) => row.projectId === projectId);
}

export async function readAllBigQueryExportPages(
  client: BigQueryExportClient,
  projectId: string,
): Promise<GcpCostRow[]> {
  const rows: GcpCostRow[] = [];
  let pageToken: string | undefined;
  for (let safety = 0; safety < GCP_COST_PAGE_LIMIT; safety += 1) {
    const page = await client.query(pageToken ? { projectId, pageToken } : { projectId });
    rows.push(...page.rows);
    if (!page.pageToken) {
      return rows;
    }
    pageToken = page.pageToken;
  }
  throw new Error("BigQuery export query exceeded page limit");
}

export function aggregatesFromRows(rows: readonly GcpCostRow[]): GcpCostAggregate[] {
  const groups = new Map<string, GcpCostRow[]>();
  for (const row of rows) {
    const key = `${row.projectId}:${row.serviceName}:${row.currency}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    if (!first) {
      return [];
    }
    return [
      {
        projectId: first.projectId,
        serviceName: first.serviceName,
        currency: first.currency,
        costAmount: totalSameCurrency(group, first.currency),
      },
    ];
  });
}

function missingRoleCoverage(projectId: string): CoverageEntry[] {
  return [
    recordCoverageScope({
      subscriptionOrProject: projectId,
      checkId: GCP_SPEND_BY_SERVICE,
      state: "unassessed",
      causeId: "missing_role",
      closer: GCP_COST_ROLE_CLOSER,
    }),
  ];
}

function mixedCurrencyCoverage(projectId: string): CoverageEntry[] {
  return [
    recordCoverageScope({
      subscriptionOrProject: projectId,
      checkId: GCP_SPEND_BY_SERVICE,
      state: "undetermined",
      closer: "Billing export rows in a single currency at that project",
    }),
  ];
}

export async function harvestGcpCost(input: {
  client: BigQueryExportClient;
  projectId: string;
  asOf?: string;
}): Promise<GcpCostHarvestResult> {
  try {
    const rows = await readAllBigQueryExportPages(input.client, input.projectId);
    if (rows.length > 0) {
      totalSameCurrency(rows, rows[0]?.currency ?? "");
    }
    const services = aggregatesFromRows(rows);
    const snapshot: GcpCostSnapshot = {
      projectId: input.projectId,
      currency: rows[0]?.currency ?? "",
      asOf: input.asOf ?? "1970-01-01T00:00:00.000Z",
      services,
      harvestStatus: GCP_COST_HARVEST_UNVERIFIED.harvestStatus,
      liveRunAt: GCP_COST_HARVEST_UNVERIFIED.liveRunAt,
      harvestStatusReason: GCP_COST_HARVEST_UNVERIFIED.harvestStatusReason,
    };
    return {
      ok: true,
      snapshot,
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: input.projectId,
          checkId: GCP_SPEND_BY_SERVICE,
          state: "assessed",
        }),
      ],
    };
  } catch (error) {
    if (error instanceof MissingBillingExportRoleError) {
      return { ok: false, reason: "missing_role", coverage: missingRoleCoverage(input.projectId) };
    }
    if (error instanceof CrossCurrencyError) {
      return { ok: false, reason: "mixed_currency", coverage: mixedCurrencyCoverage(input.projectId) };
    }
    throw error;
  }
}

export function applyGcpCostCoverage(
  existing: readonly CoverageEntry[],
  harvested: readonly CoverageEntry[],
): CoverageEntry[] {
  return applyCoverageResults(existing, harvested);
}

export { addAmounts };
