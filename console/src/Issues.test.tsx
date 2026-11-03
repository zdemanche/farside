import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Issues } from "./Issues";
import { expectAxeClean, renderScreen } from "./test-utils";

describe("Issues screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
  });

  afterEach(() => {
    cleanup();
  });

  it("filters stored issues, explains the default filter, and clears filters", async () => {
    const { container } = renderScreen(<Issues hash="issues" />);
    expect(screen.getByRole("heading", { name: "Issues" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("7 issues")).toBeTruthy());
    expect(screen.getByText(/2 more issues are hidden by the status filter/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "closed" } });
    expect(screen.getByText("1 issues")).toBeTruthy();
    expect(screen.getByRole("row", { name: /disk-fixed/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "not_confirmed" } });
    expect(screen.getByRole("row", { name: /sub-no-budget/ }).textContent).toMatch(/not confirmed/);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "open" } });
    fireEvent.change(screen.getByLabelText("Check"), {
      target: { value: "azure-waste-unattached-disks" },
    });
    fireEvent.change(screen.getByLabelText("Subscription"), { target: { value: "main" } });
    expect(screen.getByRole("link", { name: "disk-unattached" })).toBeTruthy();
    await expectAxeClean(container);

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "not_confirmed" } });
    expect(screen.getByText(/No issues match these filters/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("9 issues")).toBeTruthy();
  });

  it("shows every status from the hidden-issues hint", async () => {
    renderScreen(<Issues hash="issues" />);
    await screen.findByText("7 issues");
    fireEvent.click(screen.getByRole("button", { name: "Show all statuses" }));
    expect(screen.getByText("9 issues")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show all statuses" })).toBeNull();
  });

  it("opens detail with coverage proof", async () => {
    const { container } = renderScreen(<Issues hash="issues/disk-unattached" />);
    expect(await screen.findByRole("heading", { name: "disk-unattached" })).toBeTruthy();
    expect(screen.getByText(/Evidence diskState Unattached/)).toBeTruthy();
    expect(screen.getByText(/First seen/)).toBeTruthy();
    expect(screen.getByText(/Last confirmed/)).toBeTruthy();
    expect(screen.getByText(/Coverage assessed/)).toBeTruthy();
    await expectAxeClean(container);
  });
});
