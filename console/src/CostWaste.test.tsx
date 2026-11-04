import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostWaste } from "./CostWaste";
import { demoSource } from "./data/demo";
import { Issues } from "./Issues";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

describe("Cost and waste screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  afterEach(() => {
    cleanup();
  });

  it("shows spend, floor and burst, commitment use and waste, and is axe clean", async () => {
    const { container } = renderScreen(<CostWaste />);
    await waitFor(() =>
      expect(screen.getByText("Spend by service", { selector: "h2" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("row", { name: /Virtual Machines.*USD\s1,840\.00.*15\.00%/ }),
    ).toBeTruthy();
    expect(screen.getByText("2026-10-01 to 2026-10-31")).toBeTruthy();
    expect(screen.getByText(/a floor of USD\s58\.00 and a burst of USD\s16\.00/)).toBeTruthy();
    expect(
      screen.getByRole("row", { name: /res-d2s.*Standard_D2s_v5.*62%.*2027-03-01/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("row", { name: /disk-unattached.*diskState Unattached, sizeGb 128/ }),
    ).toBeTruthy();
    await expectAxeClean(container);
  });

  it("states how many scopes were not assessed next to the waste range", async () => {
    renderScreen(<CostWaste />);
    await waitFor(() =>
      expect(screen.getAllByText(/USD\s8\.00 to USD\s12\.00 per month/).length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/2 scopes not assessed, so this is a lower bound/)).toBeTruthy();
  });

  it("links each waste row to an issue the Issues screen can open", async () => {
    renderScreen(<CostWaste />);
    const link = await screen.findByRole("link", { name: "View issue for disk-unattached" });
    const hash = link.getAttribute("href")?.replace(/^#/, "") ?? "";
    cleanup();
    renderScreen(<Issues hash={hash} />);
    expect(await screen.findByRole("heading", { name: "disk-unattached" })).toBeTruthy();
    expect(screen.queryByText(/was not found/)).toBeNull();
  });

  it("marks unverified commitments and shows savings plan use", async () => {
    const base = await demoSource().costWaste();
    renderScreen(
      <CostWaste />,
      sourceWith({
        costWaste: async () => ({
          ...base,
          commitments: {
            reservations: [],
            savingsPlans: [
              {
                savingsPlanId: "sp-1",
                committedAmount: "100.00",
                usedAmount: "40.00",
                utilisationPercent: 40,
                expiryDate: "2027-01-01",
                currency: "USD",
              },
            ],
            noneFound: { reservations: true, savingsPlans: false },
            harvestStatus: "unverified",
          },
        }),
      }),
    );
    expect(await screen.findByText(/Not verified against a live run/)).toBeTruthy();
    expect(screen.getByRole("row", { name: /sp-1.*Savings plan.*40%/ })).toBeTruthy();
  });

  it("says no waste was found when nothing assessed failed", async () => {
    const base = await demoSource().costWaste();
    renderScreen(
      <CostWaste />,
      sourceWith({
        costWaste: async () => ({
          ...base,
          waste: [],
          totals: { ...base.totals, assessedCount: 0, unassessedScopes: 0 },
        }),
      }),
    );
    expect(await screen.findByText(/No waste was found on scopes that were assessed/)).toBeTruthy();
    expect(screen.queryByText(/lower bound/)).toBeNull();
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

  it("reports a load failure with a retry", async () => {
    const { DataError } = await import("./data/error");
    renderScreen(
      <CostWaste />,
      sourceWith({
        costWaste: async () => {
          throw new DataError("failed", 500, "boom");
        },
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
