import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { ISSUE_ROWS } from "./issues-data";

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

  it("filters stored issues and opens detail with coverage proof", async () => {
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "Issues" })).toBeTruthy();
    const open = ISSUE_ROWS.filter((issue) => issue.status === "open");
    expect(screen.getByRole("status").textContent).toBe(`${open.length} issues`);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "closed" } });
    expect(screen.getByRole("status").textContent).toBe("1 issues");
    expect(screen.getByRole("row", { name: /disk-fixed/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "not_confirmed" } });
    expect(screen.getByRole("row", { name: /disk-unconfirmed/ }).textContent).toMatch(/not confirmed/);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "open" } });
    fireEvent.change(screen.getByLabelText("Check"), {
      target: { value: "azure-waste-unattached-disks" },
    });
    fireEvent.change(screen.getByLabelText("Subscription"), { target: { value: "main" } });
    expect(screen.getByRole("link", { name: "disk-unattached" })).toBeTruthy();
    const listResults = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(listResults.violations).toEqual([]);
    cleanup();
    window.location.hash = "#issues/disk-unattached";
    const detail = render(<App />);
    expect(screen.getByRole("heading", { name: "disk-unattached" })).toBeTruthy();
    expect(screen.getByText(/Evidence diskState Unattached/)).toBeTruthy();
    expect(screen.getByText(/First seen/)).toBeTruthy();
    expect(screen.getByText(/Last confirmed/)).toBeTruthy();
    expect(screen.getByText(/Coverage assessed/)).toBeTruthy();
    const detailResults = await axe.run(detail.container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(detailResults.violations).toEqual([]);
  });
});
