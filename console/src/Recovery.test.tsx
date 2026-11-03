import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recovery } from "./Recovery";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

const NEVER_SCANNED = {
  empty: true,
  resourceTotal: 0,
  noOwnerTotal: 0,
  coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
  healthScore: null,
};

describe("Recovery screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
  });

  afterEach(() => {
    cleanup();
  });

  it("lists backup and redundancy gaps with N of M and coverage", async () => {
    const { container } = renderScreen(<Recovery />);
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Recovery gaps" });
    expect(screen.getByRole("status").textContent).toBe("2 of 4 production systems lack backup");
    const vm = screen.getByRole("row", { name: /vm-prod-no-backup/ });
    expect(vm.textContent).toContain("azure-resilience-prod-vms-outside-backup");
    expect(vm.textContent).toContain("protected false");
    expect(vm.textContent).toContain("assessed");
    expect(table.textContent).toContain("sql-prod-no-backup");
    expect(table.textContent).toContain("db-no-zone-geo");
    expect(table.textContent).not.toContain("vm-prod-backed-up");
    await expectAxeClean(container);
  });

  it("never says 0 of N when some systems could not be checked", async () => {
    renderScreen(
      <Recovery />,
      sourceWith({
        recovery: async () => ({
          rows: [{ id: "x", system: "vm-x", checkId: "c", evidence: "", coverage: "assessed" }],
          unprotected: 0,
          checked: 1,
          undetermined: 2,
        }),
      }),
    );
    await screen.findByRole("table");
    expect(screen.getByRole("status").textContent).toBe(
      "0 of 1 checked lack backup; 2 could not be checked",
    );
  });

  it("says not checked yet, not no gaps, on a never-scanned org", async () => {
    renderScreen(
      <Recovery />,
      sourceWith({
        overview: async () => NEVER_SCANNED,
        recovery: async () => ({ rows: [], unprotected: 0, checked: 0, undetermined: 0 }),
      }),
    );
    expect(await screen.findByText(/Not checked yet/)).toBeTruthy();
    expect(screen.queryByText(/No backup or redundancy gaps/)).toBeNull();
  });
});
