import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recovery } from "./Recovery";
import { expectAxeClean, renderScreen } from "./test-utils";

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
});
