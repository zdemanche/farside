import { describe, expect, it } from "vitest";
import { validateFinding } from "@farside/scan-contracts";
import type { ResourceFacts } from "./facts.js";
import {
  checkGcpIdleRecommendations,
  checkGcpIdleRecs,
  GCP_IDLE_RECS,
  RECOMMENDER_CEILING_BASIS,
  RECOMMENDER_RANGE_CLOSER,
  RECOMMENDER_SAVINGS_BASIS,
  REC_TYPE,
} from "./gcp-recommender.js";

// #199, option B: live Recommender's one projected figure becomes a range from zero up to it.

const RECOMMENDATION = {
  recommendationId: "rec-vm-parked",
  recommenderId: "google.compute.instance.IdleResourceRecommender",
  resourceName:
    "//compute.googleapis.com/projects/farside-test/zones/us-central1-a/instances/vm-parked",
  subtype: "IDLE_VM",
  projectId: "farside-test",
  currency: "USD",
};

describe("a Recommender figure read as a ceiling (#199)", () => {
  it("fails with a range from zero up to the figure, naming that basis", () => {
    const { findings } = checkGcpIdleRecommendations("farside-test", {
      ok: true,
      recommendations: [
        { ...RECOMMENDATION, savingsMin: 0, savingsMax: 24.5, savingsCeiling: true },
      ],
    });
    const finding = findings[0]!;
    expect(finding.result).toBe("fail");
    expect(finding.savings).toEqual({ min: "0.00", max: "24.50", currency: "USD" });
    expect(finding.evidence.fields.savingsBasis).toBe(RECOMMENDER_CEILING_BASIS);
    expect(validateFinding(finding)).toEqual([]);
  });

  it("keeps a point figure with no ceiling mark undetermined, as before", () => {
    const { findings } = checkGcpIdleRecommendations("farside-test", {
      ok: true,
      recommendations: [{ ...RECOMMENDATION, savingsMin: 24.5, savingsMax: 24.5 }],
    });
    expect(findings[0]).toMatchObject({ result: "undetermined", closer: RECOMMENDER_RANGE_CLOSER });
    expect(findings[0]?.savings).toBeUndefined();
  });

  it("keeps the original basis for a real range with no ceiling mark", () => {
    const { findings } = checkGcpIdleRecommendations("farside-test", {
      ok: true,
      recommendations: [{ ...RECOMMENDATION, savingsMin: 20, savingsMax: 32 }],
    });
    expect(findings[0]?.evidence.fields.savingsBasis).toBe(RECOMMENDER_SAVINGS_BASIS);
  });

  it("reads the ceiling mark from facts", () => {
    const uri =
      "//recommender.googleapis.com/projects/farside-test/locations/us-central1-a/recommenders/r/recommendations/rec-1";
    const facts: ResourceFacts[] = [
      {
        resourceUri: uri,
        fields: {
          ...RECOMMENDATION,
          location: "us-central1-a",
          savingsMin: 0,
          savingsMax: 12.25,
          savingsCeiling: true,
        },
      },
    ];
    const findings = checkGcpIdleRecs(
      {
        cloud: "gcp",
        resources: [
          {
            resourceUri: uri,
            resourceType: REC_TYPE,
            region: "us-central1-a",
            displayName: "rec-1",
            tags: {},
            ownerTag: null,
          },
        ],
      } as never,
      facts,
    );
    const finding = findings.find((item) => item.checkId === GCP_IDLE_RECS);
    expect(finding?.savings).toEqual({ min: "0.00", max: "12.25", currency: "USD" });
  });
});
