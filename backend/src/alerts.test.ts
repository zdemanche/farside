import { afterAll, describe, expect, it } from "vitest";
import {
  WINDOW_DAYS,
  analyzeAlerts,
  backtest,
  evaluateAlerts,
  floorBurst,
  replayFixture,
} from "./alerts.js";
import { buildApp } from "./app.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const FIXTURE = replayFixture();

describe("floor and burst", () => {
  it("uses the rolling 14-day minimum as floor and actual minus floor as burst", () => {
    const points = floorBurst(FIXTURE.rows, FIXTURE.asOf);
    const asOf = points.find((point) => point.date === "2026-10-15");
    expect(asOf).toMatchObject({ actual: "260.00", floor: "100.00", burst: "160.00" });
    const first = points.find((point) => point.date === "2026-10-02");
    expect(first?.floor).toBe("100.00");
  });
});

describe("relative alert rules", () => {
  it("raises org, subscription, service and new-service alerts against the customer's history", () => {
    const { alerts, undetermined } = evaluateAlerts(FIXTURE.rows, FIXTURE.asOf);
    expect(undetermined).toBeNull();
    expect(alerts.map((alert) => alert.kind).sort()).toEqual([
      "NEW_SERVICE",
      "ORG_SPIKE",
      "SERVICE_SPIKE",
      "SUBSCRIPTION_SPIKE",
    ]);
    expect(alerts.every((alert) => alert.isNew)).toBe(true);
    expect(JSON.stringify(alerts)).not.toMatch(/\$50|\$25|\$100|\$5/);
  });

  it("is undetermined until 14 prior days exist", () => {
    const short = FIXTURE.rows.filter((row) => row.date <= "2026-10-10");
    const { alerts, undetermined } = evaluateAlerts(short, "2026-10-10");
    expect(alerts).toEqual([]);
    expect(undetermined?.daysNeeded).toBe(WINDOW_DAYS - 9);
  });

  it("does not treat the same alert on the next day as new", () => {
    const first = evaluateAlerts(FIXTURE.rows, "2026-10-15").alerts;
    const extra = FIXTURE.rows.concat(
      FIXTURE.rows
        .filter((row) => row.date === "2026-10-15")
        .map((row) => ({ ...row, date: "2026-10-16" })),
    );
    const second = evaluateAlerts(extra, "2026-10-16", first).alerts;
    expect(second.find((alert) => alert.kind === "ORG_SPIKE")?.isNew).toBe(false);
    expect(second.find((alert) => alert.kind === "SUBSCRIPTION_SPIKE")?.isNew).toBe(false);
  });
});

describe("digest and backtest", () => {
  it("groups alerts into one undelivered digest for configured recipients", () => {
    const analysis = analyzeAlerts({ recipients: ["cto@example.test"] });
    expect(analysis.digest.alerts).toHaveLength(4);
    expect(analysis.digest.delivered).toBe(false);
    expect(analysis.digest.reason).toBe("no_mail_path");
    expect(analysis.digest.recipients).toEqual(["cto@example.test"]);
    const none = analyzeAlerts({ recipients: [] });
    expect(none.digest.reason).toBe("no_recipients");
  });

  it("pins the replay alert count so a quieter series must update the expected count", () => {
    expect(backtest()).toBe(FIXTURE.expectedNewAlerts);
    const quiet = FIXTURE.rows.filter((row) => row.date < FIXTURE.asOf);
    expect(backtest(quiet, "2026-10-14")).not.toBe(FIXTURE.expectedNewAlerts);
    expect(backtest(quiet, "2026-10-14")).toBe(0);
  });
});

describe("alert routes", () => {
  const store = new MemoryStore();
  const app = buildApp(store);

  afterAll(async () => {
    await app.close();
  });

  it("analyses the replay fixture through the API", async () => {
    const posted = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/alerts",
      headers: ORG,
      payload: { recipients: ["cto@example.test"] },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().alerts).toHaveLength(4);
    expect(posted.json().digest.delivered).toBe(false);
    const stored = await app.inject({
      method: "GET",
      url: "/v1/orgs/org-a/alerts",
      headers: ORG,
    });
    expect(stored.json().floorBurst.at(-1).burst).toBe("160.00");
  });
});
