import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostWaste } from "./CostWaste";
import { demoSource } from "./data/demo";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

describe("Cost and waste screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  afterEach(() => {
    cleanup();
  });

  it("shows spend, floor and burst, commitments and waste with issue links", async () => {
    const { container } = renderScreen(<CostWaste />);
    await waitFor(() =>
      expect(screen.getByText("Spend by service", { selector: "h2" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("row", { name: /Virtual Machines.*USD\s1,840\.00.*15\.00%/ }),
    ).toBeTruthy();
    expect(screen.getByText(/a floor of USD\s58\.00 and a burst of USD\s16\.00/)).toBeTruthy();
    expect(screen.getByText("No reservations or savings plans were found.")).toBeTruthy();
    const row = screen.getByRole("row", { name: /disk-orphan-1/ });
    expect(within(row).getByRole("link", { name: "View issue" }).getAttribute("href")).toBe(
      "#issues/disk-orphan-1",
    );
    await expectAxeClean(container);
  });

  it("states how many scopes were not assessed next to the waste range", async () => {
    renderScreen(<CostWaste />);
    await waitFor(() =>
      expect(screen.getAllByText(/USD\s9\.00 to USD\s12\.00 per month/).length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/2 scopes not assessed, so this is a lower bound/)).toBeTruthy();
  });

  it("shows no figures when cost could not be read", async () => {
    const base = await demoSource().costWaste();
    const { container } = renderScreen(
      <CostWaste />,
      sourceWith({
        costWaste: async () => ({
          ...base,
          readable: false,
          reason: "cost could not be read",
          spend: null,
          floorBurst: null,
          commitments: null,
        }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Cost could not be read/),
    );
    expect(screen.queryByText("Spend by service", { selector: "h2" })).toBeNull();
    expect(container.textContent).not.toMatch(/USD/);
    await expectAxeClean(container);
  });
});
