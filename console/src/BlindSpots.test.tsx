import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEALTH_SCORE_FORMULA, scoreHealth } from "@farside/scan-contracts";
import { App } from "./App";
import { BLIND_SPOT_HEALTH, BLIND_SPOT_ROWS } from "./blind-spots";

describe("Blind spots screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
    window.location.hash = "#blind-spots";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("lists what could not be checked, why, and what would close it", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Blind spots" })).toBeTruthy();
    expect(screen.getByText(HEALTH_SCORE_FORMULA)).toBeTruthy();
    expect(
      screen.getByRole("status").textContent,
    ).toContain(`${BLIND_SPOT_HEALTH.unassessedScopes} of`);
    const table = screen.getByRole("table", { name: "What Farside could not check" });
    for (const spot of BLIND_SPOT_ROWS) {
      expect(table.textContent).toContain(spot.checkId);
      expect(table.textContent).toContain(spot.reason);
      expect(table.textContent).toContain(spot.closer);
    }
    const undetermined = screen.getByRole("row", {
      name: /azure-resilience-prod-vms-outside-backup/,
    });
    expect(undetermined.textContent).toMatch(/missing a required Azure role/);
    expect(undetermined.textContent).toMatch(/Grant the missing read-only role/);
  });

  it("uses the contract scoring helper and does not reimplement it", () => {
    const baseline = scoreHealth(
      {
        scopes: [{ id: "a:check", checkId: "check", assessed: true }],
      },
      [
        {
          checkId: "check",
          result: "fail",
          evidence: { fields: { ok: false } },
          scope: { id: "a:check", cloud: "azure", subscriptionOrProject: "a" },
        },
      ],
    );
    const withUnassessed = scoreHealth(
      {
        scopes: [
          { id: "a:check", checkId: "check", assessed: true },
          { id: "b:check", checkId: "check", assessed: false },
        ],
      },
      [
        {
          checkId: "check",
          result: "fail",
          evidence: { fields: { ok: false } },
          scope: { id: "a:check", cloud: "azure", subscriptionOrProject: "a" },
        },
      ],
    );
    expect(withUnassessed.score).toBe(baseline.score);
    expect(BLIND_SPOT_HEALTH.score).toBeNull();
  });

  it("has no axe violations and labels every row", async () => {
    const { container } = render(<App />);
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBe(BLIND_SPOT_ROWS.length + 1);
    for (const spot of BLIND_SPOT_ROWS) {
      expect(screen.getByRole("row", { name: new RegExp(spot.checkId) })).toBeTruthy();
    }
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
