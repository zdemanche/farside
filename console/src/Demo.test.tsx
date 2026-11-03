import { cleanup, render, screen } from "@testing-library/react";
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

describe("demo mode screens", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it.each(PAGES)("shows the Demo label and populated $heading", ({ hash, heading, populated }) => {
    window.location.hash = hash;
    render(<App demo />);
    expect(screen.getByText(DEMO_LABEL)).toBeTruthy();
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.getByText(populated)).toBeTruthy();
  });
});
