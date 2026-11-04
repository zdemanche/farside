import { afterAll, describe, expect, it } from "vitest";
import {
  CURRENCY_CLOSER,
  WINDOW_DAYS,
  analyzeAlerts,
  backtest,
  evaluateAlerts,
  floorBurst,
  gcpReplayFixture,
  gcpRowsToDailyCost,
  historyDays,
  memoryMailer,
  replayFixture,
} from "./alerts.js";
import { buildApp } from "./app.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

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
    const { alerts, undetermined, historyDays: available } = evaluateAlerts(short, "2026-10-10");
    expect(alerts).toEqual([]);
    expect(available).toBe(9);
    expect(undetermined).toEqual({
      historyDays: 9,
      daysNeeded: WINDOW_DAYS - 9,
      closer: "5 more completed export days",
    });
  });

  it("is undetermined, never summed, when rows mix currencies", () => {
    const mixed = FIXTURE.rows.map((row, index) => (index === 0 ? { ...row, currency: "EUR" } : row));
    const analysis = analyzeAlerts({ rows: mixed, asOf: FIXTURE.asOf });
    expect(analysis.alerts).toEqual([]);
    expect(analysis.floorBurst).toEqual([]);
    expect(analysis.undetermined).toMatchObject({ reason: "mixed_currency", closer: CURRENCY_CLOSER });
  });

  it("reports mixed_currency even with fewer than 14 days of history", () => {
    const short = FIXTURE.rows.filter((row) => row.date <= "2026-10-10");
    const mixed = short.map((row, index) => (index === 0 ? { ...row, currency: "EUR" } : row));
    const { undetermined } = evaluateAlerts(mixed, "2026-10-10");
    expect(undetermined).toMatchObject({ reason: "mixed_currency", closer: CURRENCY_CLOSER });
  });

  it("counts GCP export days and stays undetermined on an empty first day", () => {
    const gcpSeries = [
      {
        date: "2026-11-03",
        subscriptionId: "farside-test",
        serviceName: "Compute Engine",
        costAmount: "1.00",
        currency: "USD",
      },
    ];
    expect(historyDays(gcpSeries, "2026-11-03")).toBe(0);
    const emptyFirst = evaluateAlerts([], "2026-11-03");
    expect(emptyFirst.alerts).toEqual([]);
    expect(emptyFirst.historyDays).toBe(0);
    expect(emptyFirst.undetermined).toEqual({
      historyDays: 0,
      daysNeeded: WINDOW_DAYS,
      closer: "14 more completed export days",
    });
    const firstDay = evaluateAlerts(gcpSeries, "2026-11-04");
    expect(firstDay.historyDays).toBe(1);
    expect(firstDay.undetermined?.daysNeeded).toBe(13);
    expect(firstDay.undetermined?.closer).toBe("13 more completed export days");
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

describe("gcp floor burst and alerts", () => {
  const gcp = gcpReplayFixture();
  const rows = gcpRowsToDailyCost(gcp.rows);

  it("reuses the relative rules on a GCP project series", () => {
    const points = floorBurst(rows, gcp.asOf);
    expect(points.find((point) => point.date === gcp.asOf)).toMatchObject({
      actual: "260.00",
      floor: "100.00",
      burst: "160.00",
    });
    const { alerts, undetermined, historyDays: available } = evaluateAlerts(rows, gcp.asOf);
    expect(undetermined).toBeNull();
    expect(available).toBe(WINDOW_DAYS);
    expect(alerts.map((alert) => alert.kind).sort()).toEqual([
      "NEW_SERVICE",
      "ORG_SPIKE",
      "SERVICE_SPIKE",
      "SUBSCRIPTION_SPIKE",
    ]);
    expect(alerts.find((alert) => alert.kind === "SUBSCRIPTION_SPIKE")?.scope).toBe("farside-test");
    expect(backtest(rows, gcp.asOf)).toBe(gcp.expectedNewAlerts);
  });
});

describe("digest and backtest", () => {
  it("groups alerts into one undelivered digest for configured recipients", () => {
    const analysis = analyzeAlerts({
      rows: FIXTURE.rows,
      asOf: FIXTURE.asOf,
      recipients: ["cto@example.test"],
    });
    expect(analysis.digest.alerts).toHaveLength(4);
    expect(analysis.digest.delivered).toBe(false);
    expect(analysis.digest.reason).toBe("no_mail_path");
    expect(analysis.digest.recipients).toEqual(["cto@example.test"]);
    const none = analyzeAlerts({ rows: FIXTURE.rows, asOf: FIXTURE.asOf, recipients: [] });
    expect(none.digest.reason).toBe("no_recipients");
  });

  it("sends one digest through an injected mailer and follows a recipient change", () => {
    const mailer = memoryMailer();
    const first = analyzeAlerts({
      rows: FIXTURE.rows,
      asOf: FIXTURE.asOf,
      recipients: ["cto@example.test"],
      mailer,
    });
    expect(first.digest.delivered).toBe(true);
    expect(first.digest.reason).toBe("sent");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.recipients).toEqual(["cto@example.test"]);
    expect(mailer.sent[0]?.alerts).toHaveLength(4);
    const changed = analyzeAlerts({
      rows: FIXTURE.rows,
      asOf: FIXTURE.asOf,
      recipients: ["ops@example.test"],
      mailer,
    });
    expect(changed.digest.recipients).toEqual(["ops@example.test"]);
    expect(mailer.sent[1]?.recipients).toEqual(["ops@example.test"]);
  });

  it("pins the replay alert count so a quieter series must update the expected count", () => {
    expect(backtest()).toBe(FIXTURE.expectedNewAlerts);
    const quiet = FIXTURE.rows.filter((row) => row.date < FIXTURE.asOf);
    expect(backtest(quiet, "2026-10-14")).not.toBe(FIXTURE.expectedNewAlerts);
    expect(backtest(quiet, "2026-10-14")).toBe(0);
  });
});

describe("alert routes", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, TEST_APP_OPTIONS);

  afterAll(async () => {
    await app.close();
  });

  it("analyses the replay fixture through the API", async () => {
    const posted = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/alerts",
      headers: ORG,
      payload: { recipients: ["cto@example.test"], rows: FIXTURE.rows, asOf: FIXTURE.asOf },
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

  it("uses Settings.alertRecipients when the POST omits recipients", async () => {
    const store = new MemoryStore(fixedClock);
    const mailer = memoryMailer();
    const app = buildApp(store, { ...TEST_APP_OPTIONS, mailer });
    await store.putSettings("org-b", {
      ...DEFAULT_SETTINGS,
      alertRecipients: ["finance@example.test"],
      updatedAt: fixedClock(),
    });
    const posted = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-b/alerts",
      headers: { [ORG_HEADER]: "org-b", [ACTOR_HEADER]: "actor-b" },
      payload: { rows: FIXTURE.rows, asOf: FIXTURE.asOf },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().digest.recipients).toEqual(["finance@example.test"]);
    expect(posted.json().digest.delivered).toBe(true);
    expect(mailer.sent[0]?.recipients).toEqual(["finance@example.test"]);
    await app.close();
  });
});
