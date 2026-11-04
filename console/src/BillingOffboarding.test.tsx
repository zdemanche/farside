import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Billing } from "./Billing";
import { demoSource } from "./data/demo";
import { DataError } from "./data/error";
import type { DeletionView } from "./data/types";
import { Offboarding } from "./Offboarding";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

const RECORD: DeletionView = {
  orgId: "o",
  requestedBy: "actor",
  deletedAt: "2026-11-01T10:00:00.000Z",
  rowsPurged: { findings: 4, issues: 3 },
  connectionsRemoved: 1,
  scansStopped: 0,
  scheduleCancelled: true,
  accountClosureAt: null,
  trigger: "customer",
  grantsToRemove: [
    { kind: "azure-role", name: "Reader" },
    { kind: "azure-role", name: "Cost Management Reader", optional: true },
    { kind: "admin-consent", name: "Farside multi-tenant app registration" },
  ],
};

beforeEach(() => {
  document.documentElement.lang = "en";
});

afterEach(() => {
  cleanup();
});

describe("Billing screen", () => {
  it("shows plan, status, amount due and an honest empty invoice list", async () => {
    const { container } = renderScreen(<Billing />);
    expect(await screen.findByText("Farside Standard")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("No invoices have been issued yet.")).toBeTruthy();
    expect(screen.getByText(/holds no card details/)).toBeTruthy();
    await expectAxeClean(container);
  });

  it("says scans are stopped when the contract is paused and shows the retention date", async () => {
    const base = await demoSource().billing();
    renderScreen(
      <Billing />,
      sourceWith({
        billing: async () => ({
          ...base,
          contract: { ...base.contract, state: "paused", amountDue: "120.00" },
          canScan: false,
          retainUntil: "2026-12-30T00:00:00.000Z",
        }),
      }),
    );
    expect(await screen.findByText(/Scans are stopped/)).toBeTruthy();
    expect(screen.getByText(/Paused: scans are stopped/)).toBeTruthy();
    expect(screen.getByText("Data kept until")).toBeTruthy();
  });

  it("explains when no contract exists instead of showing an error", async () => {
    renderScreen(
      <Billing />,
      sourceWith({
        billing: async () => {
          throw new DataError("not-found", 404, "404 Not found");
        },
      }),
    );
    expect(await screen.findByText(/No contract is set up/)).toBeTruthy();
  });
});

describe("Offboarding screen", () => {
  it("keeps Leave disabled until both boxes are ticked, then lists the grants to remove", async () => {
    const offboard = vi.fn(async () => RECORD);
    const { container } = renderScreen(<Offboarding />, sourceWith({ offboard }));
    const leave = await screen.findByRole("button", { name: "Leave Farside" });
    expect((leave as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/downloaded my data or I do not need it/));
    expect((leave as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Delete my Farside data/));
    expect((leave as HTMLButtonElement).disabled).toBe(false);
    await expectAxeClean(container);
    fireEvent.click(leave);
    await waitFor(() => expect(screen.getByText(/Your data was deleted on/)).toBeTruthy());
    expect(offboard).toHaveBeenCalledOnce();
    expect(screen.getByText("Farside multi-tenant app registration")).toBeTruthy();
    expect(screen.getByText(/Cost Management Reader/).textContent).toMatch(/optional/);
    expect(screen.queryByRole("button", { name: "Leave Farside" })).toBeNull();
  });

  it("asks for every export across all clouds, whatever the cloud selector says", async () => {
    const exportFile = vi.fn(async (kind: string) => ({ filename: `${kind}.json`, content: "{}" }));
    renderScreen(<Offboarding />, sourceWith({ exportFile }));
    for (const name of ["Export issues", "Export inventory", "Export cost"]) {
      fireEvent.click(await screen.findByRole("button", { name }));
    }
    await waitFor(() => expect(exportFile).toHaveBeenCalledTimes(3));
    for (const call of exportFile.mock.calls) {
      expect((call as unknown[])[2]).toEqual({ allClouds: true });
    }
  });

  it("shows the grant list for an org that already left", async () => {
    renderScreen(<Offboarding />, sourceWith({ deletion: async () => RECORD }));
    expect(
      await screen.findByText("Access to remove from your cloud", { selector: "h2" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Leave Farside" })).toBeNull();
  });

  it("reports a failed offboard and lets the user try again", async () => {
    renderScreen(
      <Offboarding />,
      sourceWith({
        offboard: async () => {
          throw new DataError("failed", 500, "boom");
        },
      }),
    );
    fireEvent.click(await screen.findByLabelText(/downloaded my data/));
    fireEvent.click(screen.getByLabelText(/Delete my Farside data/));
    fireEvent.click(screen.getByRole("button", { name: "Leave Farside" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/offboard/i);
    expect(
      (screen.getByRole("button", { name: "Leave Farside" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
