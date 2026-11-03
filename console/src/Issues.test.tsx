import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Issues } from "./Issues";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

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
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "closed" },
    });
    expect(screen.getByText("1 issue")).toBeTruthy();
    expect(screen.getByRole("row", { name: /disk-fixed/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "not_confirmed" },
    });
    expect(screen.getByRole("row", { name: /sub-no-budget/ }).textContent).toMatch(/not confirmed/);
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "open" },
    });
    fireEvent.change(screen.getByLabelText("Check"), {
      target: { value: "azure-waste-unattached-disks" },
    });
    fireEvent.change(screen.getByLabelText("Subscription"), {
      target: { value: "main" },
    });
    expect(screen.getByRole("link", { name: "disk-unattached" })).toBeTruthy();
    await expectAxeClean(container);

    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "not_confirmed" },
    });
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

  it("links a closed issue to the scan that closed it", async () => {
    renderScreen(<Issues hash="issues/disk-fixed" />);
    expect((await screen.findByRole("link", { name: "scan-1" })).getAttribute("href")).toBe(
      "#scans/scan-1",
    );
  });

  it("links a not-confirmed issue to blind spots", async () => {
    renderScreen(<Issues hash="issues/sub-no-budget" />);
    const article = (await screen.findByRole("heading", { name: "sub-no-budget" })).closest(
      "article",
    ) as HTMLElement;
    expect(
      within(article).getByRole("link", { name: "See blind spots" }).getAttribute("href"),
    ).toBe("#blind-spots");
  });

  it("says an unknown issue id was not found and links back", async () => {
    const { container } = renderScreen(<Issues hash="issues/nope" />);
    expect(await screen.findByRole("heading", { name: "Issue nope was not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to all issues" }).getAttribute("href")).toBe(
      "#issues",
    );
    await waitFor(() => expect(document.activeElement?.id).toBe("issue-detail-title"));
    await expectAxeClean(container);
  });

  it("says an unknown issue id was not found when the org has no issues", async () => {
    renderScreen(<Issues hash="issues/nope" />, sourceWith({ issues: async () => [] }));
    expect(await screen.findByRole("heading", { name: "Issue nope was not found" })).toBeTruthy();
    expect(screen.queryByText(/No issues have been recorded/)).toBeNull();
  });

  it("shows the short name of a resource URI and keeps the full value as the title", async () => {
    const base = {
      subscription: "s",
      status: "open" as const,
      evidence: "",
      savings: null,
      coverage: "assessed",
      firstSeen: "2026-10-14T12:00:00.000Z",
      lastConfirmed: "2026-10-14T12:00:00.000Z",
      checkId: "azure-waste-unattached-disks",
    };
    const azure = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/disks/web";
    const gcp = "//compute.googleapis.com/projects/p/zones/z/disks/web-gcp";
    renderScreen(
      <Issues hash={`issues/${encodeURIComponent("i-az")}`} />,
      sourceWith({
        issues: async () => [
          { ...base, id: "i-az", resourceId: azure },
          { ...base, id: "i-gcp", resourceId: gcp },
          { ...base, id: "i-plain", resourceId: "plain-id" },
        ],
      }),
    );
    expect((await screen.findByRole("link", { name: "web" })).getAttribute("title")).toBe(azure);
    expect(screen.getByRole("link", { name: "web-gcp" }).getAttribute("title")).toBe(gcp);
    expect(screen.getByRole("link", { name: "plain-id" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "web", level: 2 }).getAttribute("title")).toBe(
      azure,
    );
    expect(screen.getByRole("link", { name: "Find in Inventory" }).getAttribute("href")).toBe(
      `#inventory?resource=${encodeURIComponent(azure)}`,
    );
  });

  it("opens detail with coverage proof", async () => {
    const { container } = renderScreen(<Issues hash="issues/disk-unattached" />);
    expect(await screen.findByRole("heading", { name: "disk-unattached" })).toBeTruthy();
    expect(screen.getByText(/Evidence diskState Unattached/)).toBeTruthy();
    expect(screen.getByText(/First seen/)).toBeTruthy();
    expect(screen.getByText(/Last confirmed/)).toBeTruthy();
    expect(screen.getByText(/Savings USD 8.00 to USD 12.00 per month/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Find in Inventory" }).getAttribute("href")).toBe(
      "#inventory?resource=disk-unattached",
    );
    expect(screen.getByText(/^Last scan/)).toBeTruthy();
    expect(document.querySelector("time[datetime='2026-10-14T12:00:00.000Z']")).toBeTruthy();
    expect(screen.getByText(/Coverage assessed/)).toBeTruthy();
    await expectAxeClean(container);
  });
});
