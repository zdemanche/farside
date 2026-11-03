import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
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

function numbersIn(text: string, pattern: RegExp): number[] {
  const match = text.match(pattern);
  return match ? match.slice(1).map(Number) : [];
}

describe("demo mode screens", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it.each(PAGES)("shows the Demo label and populated $heading", async ({ hash, heading, populated }) => {
    window.location.hash = hash;
    render(<App demo />);
    expect(screen.getByText(DEMO_LABEL)).toBeTruthy();
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(await screen.findByText(populated)).toBeTruthy();
  });

  it("reports the same assessed and unassessed totals on Estate, Blind spots and Scans", async () => {
    window.location.hash = "#estate";
    const estate = render(<App demo />);
    await screen.findByText(/Assessed scopes/);
    const text = estate.container.textContent ?? "";
    const [assessed] = numbersIn(text, /Assessed scopes (\d+)/);
    const [unassessed] = numbersIn(text, /Unassessed scopes (\d+)/);
    const [undetermined] = numbersIn(text, /Undetermined scopes (\d+)/);
    estate.unmount();

    window.location.hash = "#blind-spots";
    const blind = render(<App demo />);
    const meta = await within(blind.container).findByText(/scopes were left out of the score/);
    const [leftOut, total] = numbersIn(meta.textContent ?? "", /(\d+) of (\d+) scopes/);
    blind.unmount();

    window.location.hash = "#scans";
    const scans = render(<App demo />);
    const current = await within(scans.container).findByRole("row", { name: /scan-1/ });
    const [scanAssessed, scanUnassessed, scanUndetermined] = numbersIn(
      current.textContent ?? "",
      /(\d+) assessed, (\d+) unassessed, (\d+) undetermined/,
    );

    expect(assessed).toBeGreaterThan(0);
    expect(unassessed).toBeGreaterThan(0);
    expect(total! - leftOut!).toBe(assessed);
    expect(leftOut).toBe(unassessed! + undetermined!);
    expect([scanAssessed, scanUnassessed, scanUndetermined]).toEqual([
      assessed,
      unassessed,
      undetermined,
    ]);
  });

  it("computes the Recovery and Lifecycle counters from the rows shown", async () => {
    window.location.hash = "#recovery";
    const recovery = render(<App demo />);
    await within(recovery.container).findByText(/production systems lack backup/);
    expect(within(screen.getByRole("main")).getByRole("status").textContent).toBe(
      "2 of 4 production systems lack backup",
    );
    expect(within(recovery.container).getAllByRole("row")).toHaveLength(1 + 3);
    recovery.unmount();

    window.location.hash = "#lifecycle";
    const lifecycle = render(<App demo />);
    await within(lifecycle.container).findByText(/losing support in 90 days/);
    expect(within(screen.getByRole("main")).getByRole("status").textContent).toBe(
      "3 things losing support in 90 days",
    );
    expect(within(lifecycle.container).getAllByRole("row")).toHaveLength(1 + 3);
  });
});
