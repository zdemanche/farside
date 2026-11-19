import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { TEST_APP_OPTIONS } from "./test-clock.js";

const HEADERS = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

const VALID = {
  ownerTagKey: "owner",
  productionTagKey: "environment",
  productionTagValue: "prod",
  snapshotRetentionDays: 30,
  certExpiryFlagDays: 60,
  scanScheduleEnabled: true,
  scanIntervalHours: 24,
  scanRetryLimit: 3,
  alertRecipients: [],
};

describe("settings numeric bounds", () => {
  const store = new MemoryStore();
  const app = buildApp(store, TEST_APP_OPTIONS);
  afterAll(() => app.close());

  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: "/v1/orgs/org-a/settings", headers: HEADERS, payload });

  it("accepts the values the console and tests use", async () => {
    expect((await put(VALID)).statusCode).toBe(200);
  });

  it.each([
    ["scanIntervalHours", 1e300],
    ["scanIntervalHours", 8761],
    ["scanRetryLimit", 21],
    ["certExpiryFlagDays", 3651],
    ["snapshotRetentionDays", 36501],
  ])("refuses %s of %s with 400 and stores nothing", async (field, value) => {
    const before = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/settings",
      headers: HEADERS,
    });
    const response = await put({ ...VALID, [field]: value });
    expect(response.statusCode).toBe(400);
    const after = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/settings",
      headers: HEADERS,
    });
    expect(after.json()).toEqual(before.json());
  });

  it("accepts the upper bounds themselves", async () => {
    const response = await put({
      ...VALID,
      scanIntervalHours: 8760,
      scanRetryLimit: 20,
      certExpiryFlagDays: 3650,
      snapshotRetentionDays: 36500,
    });
    expect(response.statusCode).toBe(200);
  });
});
