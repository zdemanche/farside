import { describe, expect, it } from "vitest";
import { RAW_PROVIDER_KEYS, validateFinding } from "@farside/scan-contracts";
import {
  checkGcpIdleRecommendations,
  EMPTY_RECOMMENDER_WORDING,
  GCP_IDLE_RECS,
  RECOMMENDER_RANGE_CLOSER,
  RECOMMENDER_ROLE_CLOSER,
  RECOMMENDER_SAVINGS_BASIS,
} from "./gcp-recommender.js";

const IDLE_VM: Parameters<typeof checkGcpIdleRecommendations>[1] = {
  ok: true,
  recommendations: [
    {
      recommendationId: "rec-vm-parked",
      recommenderId: "google.compute.instance.IdleResourceRecommender",
      resourceName: "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/instances/vm-parked",
      subtype: "IDLE_VM",
      projectId: "farside-test",
      savingsMin: 20,
      savingsMax: 32,
      currency: "USD",
    },
  ],
};

describe("gcp idle recommendations", () => {
  it("fails a fixture recommendation that cites a savings range", () => {
    const { findings, coverage } = checkGcpIdleRecommendations("farside-test", IDLE_VM);
    const fail = findings[0];
    expect(fail?.checkId).toBe(GCP_IDLE_RECS);
    expect(fail?.result).toBe("fail");
    expect(fail?.evidence.fields.recommendationId).toBe("rec-vm-parked");
    expect(fail?.evidence.fields.subtype).toBe("IDLE_VM");
    expect(fail?.savings).toEqual({ min: "20.00", max: "32.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(RECOMMENDER_SAVINGS_BASIS);
    expect(coverage[0]?.state).toBe("assessed");
    expect(validateFinding(fail!)).toEqual([]);
    expect(JSON.stringify(findings)).not.toMatch(/confirmed idle/i);
    expect(JSON.stringify(findings)).not.toMatch(/estate is clean/i);
    for (const key of RAW_PROVIDER_KEYS) {
      expect(JSON.stringify(findings)).not.toContain(key);
    }
  });

  it("says none were returned and does not claim the estate is clean", () => {
    const { findings, coverage } = checkGcpIdleRecommendations("farside-test", {
      ok: true,
      recommendations: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.result).toBe("pass");
    expect(findings[0]?.evidence.fields.noneFound).toBe(true);
    expect(findings[0]?.evidence.fields.emptyResult).toBe(EMPTY_RECOMMENDER_WORDING);
    expect(findings[0]?.savings).toBeUndefined();
    expect(JSON.stringify(findings)).toMatch(/none were returned/i);
    expect(JSON.stringify(findings)).not.toMatch(/estate is clean|no waste|confirmed idle/i);
    expect(coverage[0]?.state).toBe("assessed");
  });

  it("leaves the check unassessed when Recommender Viewer is missing", () => {
    const { findings, coverage } = checkGcpIdleRecommendations("farside-test", {
      ok: false,
      missingRole: true,
    });
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toBe(RECOMMENDER_ROLE_CLOSER);
    expect(findings[0]?.evidence.fields.missingRole).toBe("Recommender Viewer");
    expect(coverage[0]).toMatchObject({
      state: "unassessed",
      closer: RECOMMENDER_ROLE_CLOSER,
    });
  });

  it("returns undetermined when a recommendation has no savings range or a point value", () => {
    const missing = checkGcpIdleRecommendations("farside-test", {
      ok: true,
      recommendations: [
        {
          recommendationId: "rec-no-range",
          recommenderId: "google.compute.disk.IdleResourceRecommender",
          resourceName: "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/disks/disk-maybe",
          subtype: "IDLE_DISK",
          projectId: "farside-test",
        },
      ],
    });
    expect(missing.findings[0]?.result).toBe("undetermined");
    expect(missing.findings[0]?.closer).toBe(RECOMMENDER_RANGE_CLOSER);

    const point = checkGcpIdleRecommendations("farside-test", {
      ok: true,
      recommendations: [
        {
          recommendationId: "rec-point",
          recommenderId: "google.compute.instance.IdleResourceRecommender",
          resourceName: "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/instances/vm-point",
          subtype: "IDLE_VM",
          projectId: "farside-test",
          savingsMin: 10,
          savingsMax: 10,
          currency: "USD",
        },
      ],
    });
    expect(point.findings[0]?.result).toBe("undetermined");
    expect(point.findings[0]?.closer).toBe(RECOMMENDER_RANGE_CLOSER);
    expect(point.findings[0]?.savings).toBeUndefined();
  });
});
