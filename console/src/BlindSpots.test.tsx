import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEALTH_SCORE_FORMULA } from "@farside/scan-contracts";
import { BlindSpots } from "./BlindSpots";
import { expectAxeClean, renderScreen } from "./test-utils";

describe("Blind spots screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
  });

  afterEach(() => {
    cleanup();
  });

  it("lists what could not be checked, why, and what would close it", async () => {
    renderScreen(<BlindSpots />);
    expect(screen.getByRole("heading", { name: "Blind spots" })).toBeTruthy();
    expect(await screen.findByText(HEALTH_SCORE_FORMULA)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "5 of 20 scopes were left out of the score.",
    );
    const table = screen.getByRole("table", {
      name: "What Farside could not check",
    });
    expect(table.textContent).toContain("azure-cost-spend-by-service");
    expect(table.textContent).toContain("Azure throttled the API call");
    const undetermined = screen.getByRole("row", {
      name: /azure-cost-reservation-use/,
    });
    expect(undetermined.textContent).toMatch(/missing a required Azure role/);
    expect(undetermined.textContent).toMatch(/Grant Reservations Reader/);
    expect(
      within(undetermined)
        .getByRole("link", { name: "Open Connect" })
        .getAttribute("href"),
    ).toBe("#connect");
  });

  it("shows a State column that tells not assessed from undetermined", async () => {
    renderScreen(<BlindSpots />);
    const table = await screen.findByRole("table", {
      name: "What Farside could not check",
    });
    expect(
      within(table).getByRole("columnheader", { name: "State" }),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole("row", { name: /azure-cost-reservation-use/ }),
      ).getByText("undetermined"),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole("row", { name: /azure-cost-spend-by-service/ }),
      ).getByText("not assessed"),
    ).toBeTruthy();
  });

  it("has no axe violations and labels every row", async () => {
    const { container } = renderScreen(<BlindSpots />);
    await screen.findByRole("table");
    expect(screen.getAllByRole("row")).toHaveLength(5 + 1);
    await expectAxeClean(container);
  });
});
