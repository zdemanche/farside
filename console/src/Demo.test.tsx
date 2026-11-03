import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { demoSource } from "./data/demo";
import { DEMO_LABEL } from "./shell";

const PAGES = [
  { hash: "#estate", heading: "Estate", populated: /Resources \d/ },
  { hash: "#inventory", heading: "Inventory", populated: /Unattached managed disk/ },
  { hash: "#issues", heading: "Issues", populated: /disk-unattached/ },
  { hash: "#recovery", heading: "Recovery", populated: /production systems lack backup/ },
  { hash: "#lifecycle", heading: "Lifecycle", populated: /losing support in 90 days/ },
  { hash: "#scans", heading: "Scans", populated: /scan-1/ },
  { hash: "#blind-spots", heading: "Blind spots", populated: /What Farside could not check/ },
  { hash: "#settings", heading: "Settings", populated: /Owner tag key/ },
  { hash: "#connect", heading: "Connect Azure", populated: /federated credentials/ },
] as const;

describe("demo mode screens", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it.each(PAGES)(
    "shows the Demo label and populated $heading",
    async ({ hash, heading, populated }) => {
      window.location.hash = hash;
      render(<App demo />);
      expect(await screen.findByText(DEMO_LABEL)).toBeTruthy();
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
      expect(await screen.findByText(populated)).toBeTruthy();
    },
  );

  describe("coverage totals", () => {
    const coverage = async () => (await demoSource().overview()).coverage;

    it("Estate shows the overview coverage", async () => {
      const { assessed, unassessed, undetermined } = await coverage();
      window.location.hash = "#estate";
      render(<App demo />);
      expect(await screen.findByText(`Assessed scopes ${assessed}`)).toBeTruthy();
      expect(screen.getByText(`Not assessed scopes ${unassessed}`)).toBeTruthy();
      expect(screen.getByText(`Undetermined results ${undetermined}`)).toBeTruthy();
    });

    it("Blind spots counts the scopes left out of the same overview", async () => {
      const { assessed, unassessed, undetermined } = await coverage();
      window.location.hash = "#blind-spots";
      render(<App demo />);
      const left = unassessed + undetermined;
      expect(
        await screen.findByText(`${left} of ${assessed + left} scopes were left out of the score.`),
      ).toBeTruthy();
    });

    it("Scans shows the same coverage on the current scan", async () => {
      const { assessed, unassessed, undetermined } = await coverage();
      window.location.hash = "#scans";
      render(<App demo />);
      const current = await screen.findByRole("row", { name: /scan-1/ });
      expect(current.textContent).toContain(
        `${assessed} assessed, ${unassessed} not assessed, ${undetermined} undetermined`,
      );
    });
  });

  it("computes the Recovery counter from the rows shown", async () => {
    window.location.hash = "#recovery";
    const recovery = render(<App demo />);
    await within(recovery.container).findByText(/production systems lack backup/);
    expect(within(screen.getByRole("main")).getByRole("status").textContent).toBe(
      "2 of 4 production systems lack backup",
    );
    expect(within(recovery.container).getAllByRole("row")).toHaveLength(1 + 3);
  });

  it("computes the Lifecycle counter from the rows shown", async () => {
    window.location.hash = "#lifecycle";
    const lifecycle = render(<App demo />);
    await within(lifecycle.container).findByText(/losing support in 90 days/);
    expect(within(screen.getByRole("main")).getByRole("status").textContent).toBe(
      "3 things losing support in 90 days",
    );
    expect(within(lifecycle.container).getAllByRole("row")).toHaveLength(1 + 3);
  });
});
