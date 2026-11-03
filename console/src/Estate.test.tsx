import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scoreHealth } from "@farside/scan-contracts";
import { App } from "./App";
import { Estate } from "./Estate";
import { Inventory } from "./Inventory";
import { Settings } from "./Settings";
import {
  SEEDED_OVERVIEW,
  SEEDED_RESOURCES,
  applyOwnerTagKey,
  noOwnerCount,
} from "./estate-data";

async function expectAxeClean(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations).toEqual([]);
}

function phoneWidth() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
}

describe("Estate, Inventory and Settings", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
    phoneWidth();
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("points an empty overview to Connect and hides a health score", async () => {
    window.location.hash = "#estate";
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "Estate" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect a cloud estate" })).toHaveProperty(
      "hash",
      "#connect",
    );
    expect(screen.queryByText(/health score \d/i)).toBeNull();
    await expectAxeClean(container);
  });

  it("shows seeded totals, coverage and a health score from assessed scopes only", async () => {
    const { container } = render(<Estate overview={SEEDED_OVERVIEW} />);
    expect(screen.getByText(`Resources ${SEEDED_OVERVIEW.resourceTotal}`)).toBeTruthy();
    expect(screen.getByText(`No owner ${SEEDED_OVERVIEW.noOwnerTotal}`)).toBeTruthy();
    expect(screen.getByText(`Assessed scopes ${SEEDED_OVERVIEW.coverage.assessed}`)).toBeTruthy();
    expect(screen.getByText(`Unassessed scopes ${SEEDED_OVERVIEW.coverage.unassessed}`)).toBeTruthy();
    expect(
      screen.getByText(`Undetermined scopes ${SEEDED_OVERVIEW.coverage.undetermined}`),
    ).toBeTruthy();
    expect(screen.getByText(`Health score ${SEEDED_OVERVIEW.healthScore}`)).toBeTruthy();
    const baseline = scoreHealth(
      { scopes: [{ id: "main:check", checkId: "check", assessed: true }] },
      [
        {
          checkId: "check",
          result: "fail",
          evidence: { fields: { ok: false } },
          scope: { id: "main:check", cloud: "azure", subscriptionOrProject: "main" },
        },
      ],
    );
    const withUnassessed = scoreHealth(
      {
        scopes: [
          { id: "main:check", checkId: "check", assessed: true },
          { id: "ghost:check", checkId: "check", assessed: false },
        ],
      },
      [
        {
          checkId: "check",
          result: "fail",
          evidence: { fields: { ok: false } },
          scope: { id: "main:check", cloud: "azure", subscriptionOrProject: "main" },
        },
      ],
    );
    expect(withUnassessed.score).toBe(baseline.score);
    await expectAxeClean(container);
  });

  it("filters inventory by owner, service, subscription and region", async () => {
    const { container } = render(<Inventory resources={SEEDED_RESOURCES} />);
    expect(screen.getByRole("status").textContent).toBe("4 resources");
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "none" } });
    expect(screen.getByRole("status").textContent).toBe("1 resources");
    expect(screen.getByRole("row", { name: /Unattached managed disk/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Service"), {
      target: { value: "Microsoft.Compute/disks" },
    });
    expect(screen.getByRole("status").textContent).toBe("2 resources");
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Subscription"), {
      target: { value: "empty-no-budget" },
    });
    expect(screen.getByRole("status").textContent).toBe("1 resources");
    fireEvent.change(screen.getByLabelText("Subscription"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "westus" } });
    expect(screen.getByRole("status").textContent).toBe("1 resources");
    expect(screen.getByRole("row", { name: /Production VM/ })).toBeTruthy();
    await expectAxeClean(container);
  });

  it("records settings and changes the no-owner count when the owner tag key changes", async () => {
    const { container } = render(<Settings />);
    fireEvent.change(screen.getByLabelText("Owner tag key"), {
      target: { value: "cost-center" },
    });
    fireEvent.change(screen.getByLabelText("Snapshot retention days"), {
      target: { value: "45" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("status").textContent).toMatch(/cost-center/);
    expect(screen.getByRole("status").textContent).toMatch(/45 days/);
    expect(screen.getByRole("status").textContent).toMatch(/next scan/);
    fireEvent.change(screen.getByLabelText("Scan interval hours"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("status").textContent).toMatch(/12-hour schedule/);
    expect(noOwnerCount(SEEDED_RESOURCES)).toBe(1);
    expect(noOwnerCount(applyOwnerTagKey(SEEDED_RESOURCES, "cost-center"))).toBe(
      SEEDED_RESOURCES.length,
    );
    await expectAxeClean(container);
  });
});
