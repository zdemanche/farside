import type { Finding } from "@farside/scan-contracts";
import { acceptFinding } from "./checks/define.js";
import { applyCoverageResults, recordCoverageScope, type CoverageEntry } from "./coverage.js";
import {
  RESERVATION_SAVINGS_BASIS,
  SAVINGS_PLAN_SAVINGS_BASIS,
  unusedReservationSavings,
  unusedSavingsPlanSavings,
} from "./savings.js";
import { rejectUnconfigured } from "./providers/unconfigured.js";
import docAzureCommitments from "../../docs/azure/commitments.json" with { type: "json" };

export const RESERVATION_USE = "azure-cost-reservation-use";
export const SAVINGS_PLAN_USE = "azure-cost-savings-plan-use";
export const RESERVATIONS_ROLE_CLOSER =
  "Reservations Reader on the billing account that owns the reservation";
export const SAVINGS_PLAN_CLOSER = "A benefits utilisation read that includes the savings plan";
export const LOW_UTILISATION_PERCENT = 80;

export type ReservationRecord = {
  reservationId: string;
  skuName: string;
  usedHours: number;
  reservedHours: number;
  utilisationPercent: number;
  expiryDate: string;
};

export type SavingsPlanRecord = {
  savingsPlanId: string;
  committedAmount: string;
  usedAmount: string;
  utilisationPercent: number;
  expiryDate: string;
  currency: string;
};

export const COMMITMENT_HARVEST_UNVERIFIED = {
  harvestStatus: "unverified",
  liveRunAt: null,
  harvestStatusReason:
    "The test estate will not buy reservations or savings plans. Fixture utilization is not a live purchase.",
} as const;

export type CommitmentSnapshot = {
  subscriptionId: string;
  billingScope: string;
  periodStart: string;
  periodEnd: string;
  reservations: ReservationRecord[];
  savingsPlans: SavingsPlanRecord[];
  noneFound: { reservations: boolean; savingsPlans: boolean };
  harvestStatus?: "unverified";
  liveRunAt?: string | null;
  harvestStatusReason?: string;
};

export type CommitmentHarvestResult =
  | { ok: true; snapshot: CommitmentSnapshot; findings: Finding[]; coverage: CoverageEntry[] }
  | { ok: false; reason: "missing_role"; coverage: CoverageEntry[] };

export type CommitmentClient = {
  list: (input: { billingScope: string }) => Promise<{
    periodStart: string;
    periodEnd: string;
    reservations: ReservationRecord[];
    savingsPlans: SavingsPlanRecord[];
  }>;
};

export class MissingReservationsRoleError extends Error {
  constructor() {
    super("Reservations Reader is missing");
    this.name = "MissingReservationsRoleError";
  }
}

type CommitmentsFile = {
  periodStart: string;
  periodEnd: string;
  reservations: ReservationRecord[];
  savingsPlans: SavingsPlanRecord[];
};

const FIXTURE = docAzureCommitments as CommitmentsFile;

export function fixtureCommitmentClient(
  data: CommitmentsFile = FIXTURE,
): CommitmentClient {
  return {
    async list() {
      return {
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        reservations: data.reservations,
        savingsPlans: data.savingsPlans,
      };
    },
  };
}

export function emptyCommitmentClient(): CommitmentClient {
  return fixtureCommitmentClient({
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    reservations: [],
    savingsPlans: [],
  });
}

export function missingReservationsRoleClient(): CommitmentClient {
  return {
    async list() {
      throw new MissingReservationsRoleError();
    },
  };
}

function scope(subscriptionId: string, checkId: string) {
  return {
    id: `${subscriptionId}:${checkId}`,
    cloud: "azure" as const,
    subscriptionOrProject: subscriptionId,
  };
}

export function checkReservations(
  reservations: ReservationRecord[],
  input: { subscriptionId: string; periodStart: string; periodEnd: string },
): Finding[] {
  if (reservations.length === 0) {
    return [
      acceptFinding({
        checkId: RESERVATION_USE,
        result: "pass",
        evidence: {
          fields: {
            noneFound: true,
            reservationCount: 0,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
          },
        },
        scope: scope(input.subscriptionId, RESERVATION_USE),
      }),
    ];
  }
  return reservations.map((row) => {
    const low = row.utilisationPercent < LOW_UTILISATION_PERCENT;
    const unusedHours = Math.max(row.reservedHours - row.usedHours, 0);
    const savings = low && unusedHours > 0 ? unusedReservationSavings(unusedHours) : null;
    return acceptFinding({
      checkId: RESERVATION_USE,
      result: low ? "fail" : "pass",
      evidence: {
        fields: {
          reservationId: row.reservationId,
          skuName: row.skuName,
          usedHours: row.usedHours,
          reservedHours: row.reservedHours,
          utilisationPercent: row.utilisationPercent,
          expiryDate: row.expiryDate,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          ...(savings ? { savingsBasis: savings.basis } : {}),
        },
      },
      scope: scope(input.subscriptionId, RESERVATION_USE),
      ...(savings ? { savings: { min: savings.min, max: savings.max, currency: savings.currency } } : {}),
    });
  });
}

export function checkSavingsPlans(
  plans: SavingsPlanRecord[],
  input: { subscriptionId: string; periodStart: string; periodEnd: string },
): Finding[] {
  if (plans.length === 0) {
    return [
      acceptFinding({
        checkId: SAVINGS_PLAN_USE,
        result: "pass",
        evidence: {
          fields: {
            noneFound: true,
            savingsPlanCount: 0,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
          },
        },
        scope: scope(input.subscriptionId, SAVINGS_PLAN_USE),
      }),
    ];
  }
  return plans.map((row) => {
    const low = row.utilisationPercent < LOW_UTILISATION_PERCENT;
    const unused = Math.max(Number(row.committedAmount) - Number(row.usedAmount), 0);
    const savings = low && unused > 0 ? unusedSavingsPlanSavings(unused, row.currency) : null;
    return acceptFinding({
      checkId: SAVINGS_PLAN_USE,
      result: low ? "fail" : "pass",
      evidence: {
        fields: {
          savingsPlanId: row.savingsPlanId,
          committedAmount: row.committedAmount,
          usedAmount: row.usedAmount,
          utilisationPercent: row.utilisationPercent,
          expiryDate: row.expiryDate,
          currency: row.currency,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          ...(savings ? { savingsBasis: savings.basis } : {}),
        },
      },
      scope: scope(input.subscriptionId, SAVINGS_PLAN_USE),
      ...(savings ? { savings: { min: savings.min, max: savings.max, currency: savings.currency } } : {}),
    });
  });
}

function missingRoleCoverage(subscriptionId: string): CoverageEntry[] {
  return [RESERVATION_USE, SAVINGS_PLAN_USE].map((checkId) =>
    recordCoverageScope({
      subscriptionOrProject: subscriptionId,
      checkId,
      state: "unassessed",
      causeId: "missing_role",
      closer: checkId === RESERVATION_USE ? RESERVATIONS_ROLE_CLOSER : SAVINGS_PLAN_CLOSER,
    }),
  );
}

export async function harvestCommitments(input: {
  client: CommitmentClient;
  subscriptionId: string;
  billingScope: string;
}): Promise<CommitmentHarvestResult> {
  try {
    const listed = await input.client.list({ billingScope: input.billingScope });
    const snapshot: CommitmentSnapshot = {
      subscriptionId: input.subscriptionId,
      billingScope: input.billingScope,
      periodStart: listed.periodStart,
      periodEnd: listed.periodEnd,
      reservations: listed.reservations,
      savingsPlans: listed.savingsPlans,
      noneFound: {
        reservations: listed.reservations.length === 0,
        savingsPlans: listed.savingsPlans.length === 0,
      },
      harvestStatus: COMMITMENT_HARVEST_UNVERIFIED.harvestStatus,
      liveRunAt: COMMITMENT_HARVEST_UNVERIFIED.liveRunAt,
      harvestStatusReason: COMMITMENT_HARVEST_UNVERIFIED.harvestStatusReason,
    };
    const findings = [
      ...checkReservations(listed.reservations, {
        subscriptionId: input.subscriptionId,
        periodStart: listed.periodStart,
        periodEnd: listed.periodEnd,
      }),
      ...checkSavingsPlans(listed.savingsPlans, {
        subscriptionId: input.subscriptionId,
        periodStart: listed.periodStart,
        periodEnd: listed.periodEnd,
      }),
    ];
    const coverage = [RESERVATION_USE, SAVINGS_PLAN_USE].map((checkId) =>
      recordCoverageScope({
        subscriptionOrProject: input.subscriptionId,
        checkId,
        state: "assessed",
      }),
    );
    return { ok: true, snapshot, findings, coverage };
  } catch (error) {
    if (error instanceof MissingReservationsRoleError) {
      return { ok: false, reason: "missing_role", coverage: missingRoleCoverage(input.subscriptionId) };
    }
    throw error;
  }
}

export function applyCommitmentCoverage(
  existing: readonly CoverageEntry[],
  harvested: readonly CoverageEntry[],
): CoverageEntry[] {
  return applyCoverageResults(existing, harvested);
}

export function mergeCommitmentFindings(
  existing: readonly Finding[],
  next: readonly Finding[],
  subscriptionId?: string,
): Finding[] {
  const replace = new Set([RESERVATION_USE, SAVINGS_PLAN_USE]);
  const wanted = subscriptionId?.toLowerCase();
  return [
    ...existing.filter(
      (finding) =>
        !(
          replace.has(finding.checkId) &&
          (wanted === undefined || finding.scope.subscriptionOrProject.toLowerCase() === wanted)
        ),
    ),
    ...next,
  ];
}

export function defaultCommitmentClient(): CommitmentClient {
  return fixtureCommitmentClient();
}

export function unconfiguredCommitmentClient(): CommitmentClient {
  return {
    async list() {
      rejectUnconfigured();
    },
  };
}

export { RESERVATION_SAVINGS_BASIS, SAVINGS_PLAN_SAVINGS_BASIS };
