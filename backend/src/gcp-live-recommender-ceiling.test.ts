import { describe, expect, it } from "vitest";
import { gcpLiveConfigFromEnv } from "./gcp-live-harvester.js";
import { recommendationFrom } from "./gcp-live.js";

const row = {
  name: "projects/p/locations/us-central1-a/recommenders/r/recommendations/rec-1",
  stateInfo: { state: "ACTIVE" },
  recommenderSubtype: "STOP_VM",
  content: { operationGroups: [{ operations: [{ resource: "//compute/instances/vm-1" }] }] },
  primaryImpact: {
    costProjection: { cost: { currencyCode: "USD", units: "-12", nanos: -500000000 } },
  },
};

const LIVE_ENV = {
  FARSIDE_GCP_LIVE: "1",
  FARSIDE_GCP_PROJECT_ID: "farside-test-1",
  FARSIDE_GCP_POOL_PROJECT_NUMBER: "123456789",
  FARSIDE_GCP_POOL_ID: "farside-pool",
  FARSIDE_GCP_PROVIDER_ID: "farside-aws",
  FARSIDE_GCP_SERVICE_ACCOUNT: "farside@farside-test-1.iam.gserviceaccount.com",
  FARSIDE_GCP_SUBJECT_TOKEN_FILE: "/run/token",
};

describe("live Recommender ceiling (#199)", () => {
  it("keeps the single figure as savingsMax only by default", () => {
    const rec = recommendationFrom(row, "p", "r");
    expect(rec?.savingsMax).toBe(12.5);
    expect(rec).not.toHaveProperty("savingsMin");
    expect(rec).not.toHaveProperty("savingsCeiling");
  });

  it("reports zero up to the figure, marked as a ceiling, when switched on", () => {
    const rec = recommendationFrom(row, "p", "r", true);
    expect(rec).toMatchObject({ savingsMin: 0, savingsMax: 12.5, savingsCeiling: true });
  });

  it("adds nothing when Recommender gives no saving", () => {
    const none = { ...row, primaryImpact: {} };
    expect(recommendationFrom(none, "p", "r", true)).not.toHaveProperty("savingsCeiling");
  });

  it("is off in the env config unless FARSIDE_GCP_RECOMMENDER_CEILING=1", () => {
    expect(gcpLiveConfigFromEnv(LIVE_ENV)).not.toHaveProperty("recommenderCeiling");
    expect(
      gcpLiveConfigFromEnv({ ...LIVE_ENV, FARSIDE_GCP_RECOMMENDER_CEILING: "1" }),
    ).toMatchObject({ recommenderCeiling: true });
  });
});
