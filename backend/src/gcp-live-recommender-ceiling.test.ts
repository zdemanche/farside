import { describe, expect, it } from "vitest";
import { factsFromAssets, inventoryFromAssets } from "./cloud-asset.js";
import { gcpLiveConfigFromEnv, recommendationAsset } from "./gcp-live-harvester.js";
import { liveRecommenderClient, recommendationFrom } from "./gcp-live.js";
import { checkGcpIdleRecs, GCP_IDLE_RECS, RECOMMENDER_CEILING_BASIS } from "./gcp-recommender.js";

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

describe("live path end to end (#199)", () => {
  const OBSERVED = "2026-11-18T00:00:00.000Z";

  function findingFor(ceiling: boolean) {
    const rec = recommendationFrom(row, "p", "r", ceiling);
    if (!rec) {
      throw new Error("no recommendation");
    }
    const assets = [recommendationAsset({ ...rec, location: "us-central1-a" })];
    return checkGcpIdleRecs(
      inventoryFromAssets(assets, "owner", OBSERVED),
      factsFromAssets(assets),
    ).find((item) => item.checkId === GCP_IDLE_RECS);
  }

  it("keeps the ceiling mark from the reader to the finding's basis", () => {
    const finding = findingFor(true);
    expect(finding?.savings).toEqual({ min: "0.00", max: "12.50", currency: "USD" });
    expect(finding?.evidence.fields.savingsBasis).toBe(RECOMMENDER_CEILING_BASIS);
  });

  it("leaves the finding undetermined when the flag is off", () => {
    const finding = findingFor(false);
    expect(finding?.result).toBe("undetermined");
    expect(finding?.savings).toBeUndefined();
  });
});

describe("the live recommender client passes the flag through (#199)", () => {
  const rows = { recommendations: [row] };
  const fetchStub = async () =>
    new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  async function listed(recommenderCeiling: boolean) {
    const client = liveRecommenderClient({
      token: async () => "test-token",
      fetch: fetchStub,
      recommenderCeiling,
    });
    return client.list({
      projectId: "farside-test-1",
      location: "us-central1-a",
      recommenderId: "google.compute.instance.IdleResourceRecommender",
    });
  }

  it("marks the figure as a ceiling only when switched on", async () => {
    expect((await listed(true))[0]).toMatchObject({ savingsMin: 0, savingsCeiling: true });
    expect((await listed(false))[0]).not.toHaveProperty("savingsCeiling");
  });
});
