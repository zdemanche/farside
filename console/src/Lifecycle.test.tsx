import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Lifecycle } from "./Lifecycle";
import { expectAxeClean, renderScreen } from "./test-utils";

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
    const dates = screen.getAllByRole("row").slice(1).map((row) => row.textContent?.slice(0, 10));
    expect(dates).toEqual([...dates].sort());
    expect(table.textContent).toContain("2026-11-22");
    expect(table.textContent).toContain("cert-app-expiring");
    expect(table.textContent).toContain("Standard_B1ls");
    expect(table.textContent).toContain("docs/azure/retiring-skus.json");
    await expectAxeClean(container);
  });
});
