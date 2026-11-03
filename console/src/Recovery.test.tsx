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

  const gaps = sourceWith({
    recovery: async () => ({
      rows: [
        {
          id: "1",
          system: "vm-one",
          checkId: "check-one",
          evidence: "protected false",
          coverage: "assessed",
        },
        {
          id: "2",
          system: "db-two",
          checkId: "check-two",
          evidence: "zoneRedundant false",
          coverage: "undetermined",
        },
      ],
      unprotected: 1,
      checked: 3,
      undetermined: 0,
    }),
  });

  it("shows each gap with its check, evidence and coverage", async () => {
    const { container } = renderScreen(<Recovery />, gaps);
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeTruthy();
    await screen.findByRole("table", { name: "Recovery gaps" });
    const vm = screen.getByRole("row", { name: /vm-one/ });
    expect(vm.textContent).toBe("vm-onecheck-oneprotected falseassessed");
    expect(screen.getByRole("row", { name: /db-two/ }).textContent).toContain("undetermined");
    await expectAxeClean(container);
  });

  it("states the unprotected count out of the systems checked", async () => {
    renderScreen(<Recovery />, gaps);
    await screen.findByRole("table");
    expect(screen.getByRole("status").textContent).toBe("1 of 3 production systems lack backup");
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
