import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { ISSUE_ROWS } from "./issues";

describe("Issues screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
    window.location.hash = "#issues";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("lists the unattached disk and three leftover waste findings with evidence and savings", async () => {
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "Issues" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("4 open issues");
    const table = screen.getByRole("table", { name: "Open waste issues" });
    for (const issue of ISSUE_ROWS) {
      const row = screen.getByRole("row", { name: new RegExp(issue.resourceId) });
      expect(row.textContent).toContain(issue.checkId);
      expect(row.textContent).toContain(issue.evidence);
      expect(row.textContent).toMatch(/\$\d+\.\d{2}–\$\d+\.\d{2} USD/);
      expect(table.textContent).toContain(issue.savings);
    }
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
