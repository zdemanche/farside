import { assertValid, validateFinding, type Finding, type Inventory } from "@farside/scan-contracts";
import { checkDefinition } from "./checks/define.js";
import { recordCoverageScope, type CoverageEntry } from "./coverage.js";
import { projectOf } from "./providers/gcp-scope.js";
import { GCP_CUD_SAVINGS_BASIS, unusedCudSavings } from "./savings.js";
import docGcpCommitments from "../../docs/gcp/commitments.json" with { type: "json" };

export const GCP_COMMITTED_USE = "gcp-cost-committed-use";
export const CUD_LOW_UTILISATION_PERCENT = 80;
export const CUD_EXPORT_CLOSER = "Enable the BigQuery billing export";
export const CUD_NONE_FOUND_CLOSER =
  "Export rows that name a committed-use discount, or an explicit none-found coverage cell";

export type CudRecord = {
  commitmentName: string;
  utilizationPercent: number;
  committedAmount: number;
  usedAmount: number;
  currency: string;
  billingAccountId?: string;
};

export type CudHarvest =
  | { ok: true; commitments: CudRecord[]; billingAccountId?: string }
  | { ok: false; missingExport: true };

type CommitmentsFile = {
  projectId: string;
  billingAccountId: string;
  commitments: CudRecord[];
};

const FIXTURE = docGcpCommitments as CommitmentsFile;

function acceptFinding(finding: Finding): Finding {
  assertValid(validateFinding(finding));
  return finding;
}

function scope(projectId: string) {
  return {
    id: `${projectId}:${GCP_COMMITTED_USE}`,
    cloud: "gcp" as const,
    subscriptionOrProject: projectId,
  };
}

export function fixtureCudHarvest(): CudHarvest {
  return {
    ok: true,
    billingAccountId: FIXTURE.billingAccountId,
    commitments: FIXTURE.commitments,
  };
}

export function checkGcpCommittedUse(
  projectId: string,
  harvest: CudHarvest,
): { findings: Finding[]; coverage: CoverageEntry[] } {
  if (!harvest.ok) {
    return {
      findings: [
        acceptFinding({
          checkId: GCP_COMMITTED_USE,
          result: "undetermined",
          closer: CUD_EXPORT_CLOSER,
          evidence: {
            fields: {
              billingAccountId: null,
              commitmentName: null,
              utilizationPercent: null,
              missingExport: true,
            },
          },
          scope: scope(projectId),
        }),
      ],
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: projectId,
          checkId: GCP_COMMITTED_USE,
          state: "unassessed",
          causeId: "missing_role",
          closer: CUD_EXPORT_CLOSER,
        }),
      ],
    };
  }

  if (harvest.commitments.length === 0) {
    return {
      findings: [
        acceptFinding({
          checkId: GCP_COMMITTED_USE,
          result: "pass",
          evidence: {
            fields: {
              noneFound: true,
              commitmentCount: 0,
              billingAccountId: harvest.billingAccountId ?? null,
            },
          },
          scope: scope(projectId),
        }),
      ],
      coverage: [
        recordCoverageScope({
          subscriptionOrProject: projectId,
          checkId: GCP_COMMITTED_USE,
          state: "assessed",
        }),
      ],
    };
  }

  const findings = harvest.commitments.map((row) => {
    const unused = Math.max(row.committedAmount - row.usedAmount, 0);
    const low = row.utilizationPercent < CUD_LOW_UTILISATION_PERCENT;
    const savings = low && unused > 0 ? unusedCudSavings(unused, row.currency) : null;
    return acceptFinding({
      checkId: GCP_COMMITTED_USE,
      result: low ? "fail" : "pass",
      evidence: {
        fields: {
          billingAccountId: harvest.billingAccountId ?? row.billingAccountId ?? null,
          commitmentName: row.commitmentName,
          utilizationPercent: row.utilizationPercent,
          currency: row.currency,
          ...(savings ? { savingsBasis: GCP_CUD_SAVINGS_BASIS } : {}),
        },
      },
      scope: scope(projectId),
      ...(savings ? { savings: { min: savings.min, max: savings.max, currency: savings.currency } } : {}),
    });
  });

  return {
    findings,
    coverage: [
      recordCoverageScope({
        subscriptionOrProject: projectId,
        checkId: GCP_COMMITTED_USE,
        state: "assessed",
      }),
    ],
  };
}

export const checkGcpCud = checkDefinition({ checkId: GCP_COMMITTED_USE, cloud: "gcp" }, (inventory: Inventory) => {
  const projects = new Set(inventory.resources.map((resource) => projectOf(resource.resourceUri)));
  const findings: Finding[] = [];
  for (const projectId of projects) {
    findings.push(...checkGcpCommittedUse(projectId, fixtureCudHarvest()).findings);
  }
  return findings;
});
