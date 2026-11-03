import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { RECOVERY_BACKUP, RECOVERY_ROWS } from "./recovery-data";

describe("Recovery screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
    window.location.hash = "#recovery";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("lists backup and redundancy gaps with N of M and coverage", async () => {
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      `${RECOVERY_BACKUP.unprotected} of ${RECOVERY_BACKUP.production} production systems lack backup`,
    );
    const table = screen.getByRole("table", { name: "Recovery gaps" });
    for (const row of RECOVERY_ROWS) {
      const listed = screen.getByRole("row", { name: new RegExp(row.system) });
      expect(listed.textContent).toContain(row.checkId);
      expect(listed.textContent).toContain(row.evidence);
      expect(listed.textContent).toContain(row.coverage);
      expect(table.textContent).toContain(row.system);
    }
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
