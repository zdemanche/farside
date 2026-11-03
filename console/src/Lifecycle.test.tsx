import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Lifecycle } from "./Lifecycle";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

describe("Lifecycle screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
  });

  afterEach(() => {
    cleanup();
  });

  it("lists items by date and counts those losing support in 90 days", async () => {
    const { container } = renderScreen(<Lifecycle />);
    expect(screen.getByRole("heading", { name: "Lifecycle" })).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Lifecycle items by date" });
    expect(screen.getByRole("status").textContent).toBe("3 things losing support in 90 days");
    const dates = [...table.querySelectorAll("time")].map((time) => time.getAttribute("datetime"));
    expect(dates).toEqual([...dates].sort());
    expect(table.textContent).toContain("22 Nov 2026");
    expect(table.textContent).toContain("cert-app-expiring");
    expect(table.textContent).toContain("Standard_B1ls");
    expect(table.textContent).toContain("Microsoft Azure");
    expect(table.textContent).not.toContain("docs/azure");
    expect(table.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-22");
    await expectAxeClean(container);
  });

  it("says not checked yet on a never-scanned org", async () => {
    renderScreen(
      <Lifecycle />,
      sourceWith({
        overview: async () => ({
          empty: true,
          resourceTotal: 0,
          noOwnerTotal: 0,
          coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
          healthScore: null,
        }),
        lifecycle: async () => ({ rows: [], within90: 0 }),
      }),
    );
    expect(await screen.findByText(/Not checked yet/)).toBeTruthy();
    expect(screen.queryByText(/Nothing is losing support/)).toBeNull();
  });
});
