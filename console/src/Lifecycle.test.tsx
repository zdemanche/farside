import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { LIFECYCLE_ROWS, LIFECYCLE_WITHIN_90 } from "./lifecycle-data";

describe("Lifecycle screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
    window.location.hash = "#lifecycle";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("lists items by date and counts those losing support in 90 days", async () => {
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "Lifecycle" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      `${LIFECYCLE_WITHIN_90} things losing support in 90 days`,
    );
    const table = screen.getByRole("table", { name: "Lifecycle items by date" });
    const dates = LIFECYCLE_ROWS.map((row) => row.date);
    expect(dates).toEqual([...dates].sort());
    for (const row of LIFECYCLE_ROWS) {
      expect(table.textContent).toContain(row.date);
      expect(table.textContent).toContain(row.title);
      expect(table.textContent).toContain(row.source);
    }
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
