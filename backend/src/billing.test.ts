import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { CardDataError, advanceContract, canScan, parseContract } from "./billing.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";

const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };
const T0 = "2026-10-01T00:00:00.000Z";

function daysAfter(start: string, days: number): string {
  return new Date(Date.parse(start) + days * 86_400_000).toISOString();
}

describe("contract ladder", () => {
  const base = parseContract({ plan: "farside-standard", startDate: T0 }, T0);
  if (!base) {
    throw new Error("expected contract");
  }

  it("stores plan and start and allows scans while active, warning, or grace", () => {
    expect(base.plan).toBe("farside-standard");
    expect(base.startDate).toBe(T0);
    expect(canScan(base)).toBe(true);
    const warning = advanceContract(base, { now: T0, event: "failed_payment" });
    expect(warning.state).toBe("warning");
    expect(canScan(warning)).toBe(true);
    const grace = advanceContract(warning, { now: daysAfter(T0, 7) });
    expect(grace.state).toBe("grace");
    expect(canScan(grace)).toBe(true);
  });

  it("pauses scans after grace, then retains, then can end", () => {
    const warning = advanceContract(base, { now: T0, event: "failed_payment" });
    const grace = advanceContract(warning, { now: daysAfter(T0, 7) });
    const paused = advanceContract(grace, { now: daysAfter(T0, 21) });
    expect(paused.state).toBe("paused");
    expect(canScan(paused)).toBe(false);
    const retaining = advanceContract(paused, { now: daysAfter(T0, 51) });
    expect(retaining.state).toBe("retaining");
    expect(canScan(retaining)).toBe(false);
    const ended = advanceContract(retaining, { now: daysAfter(T0, 52), event: "ended" });
    expect(ended.state).toBe("ended");
    expect(canScan(ended)).toBe(false);
  });

  it("returns to active when paid and rejects card numbers", () => {
    const warning = advanceContract(base, { now: T0, event: "failed_payment" });
    const paid = advanceContract(warning, { now: daysAfter(T0, 1), event: "paid" });
    expect(paid.state).toBe("active");
    expect(paid.unpaidAt).toBeNull();
    expect(() => parseContract({ plan: "x", startDate: T0, cardNumber: "4111111111111111" }, T0)).toThrow(
      CardDataError,
    );
  });
});

describe("contract routes", () => {
  const store = new MemoryStore();
  const app = buildApp(store);

  afterAll(async () => {
    await app.close();
  });

  it("records a contract and blocks scans once paused", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/contract",
      headers: ORG,
      payload: { plan: "farside-standard", startDate: T0, asOf: T0 },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().contract.plan).toBe("farside-standard");
    expect(created.json().canScan).toBe(true);
    expect(created.json().invoices).toEqual([]);
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/contract/advance",
      headers: ORG,
      payload: { now: T0, event: "failed_payment" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/contract/advance",
      headers: ORG,
      payload: { now: daysAfter(T0, 7) },
    });
    const paused = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/contract/advance",
      headers: ORG,
      payload: { now: daysAfter(T0, 21) },
    });
    expect(paused.json().contract.state).toBe("paused");
    expect(paused.json().canScan).toBe(false);
    const scan = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/scans",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(scan.statusCode).toBe(409);
    expect(scan.json().attention).toBe("scans paused");
    const tick = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/schedule/tick",
      headers: ORG,
      payload: { now: daysAfter(T0, 22) },
    });
    expect(tick.json().action).toBe("blocked");
    expect(tick.json().scanStarted).toBe(false);
  });

  it("rejects a contract body that includes a card number", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/contract",
      headers: ORG,
      payload: { plan: "farside-standard", startDate: T0, cardNumber: "4111111111111111" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().title).toBe("Card data rejected");
  });
});
