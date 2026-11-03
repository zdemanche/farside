import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { demoSource } from "./data/demo";
import { expectAxeClean } from "./test-utils";
import { DEMO_LABEL, NOT_CONNECTED_STATE, PRODUCT_NAME, SHELL_NAV } from "./shell";

describe("console shell", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("renders Estate at the bare hash", async () => {
    render(<App demo />);
    expect(await screen.findByRole("heading", { name: "Estate" })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Estate - Farside"));
  });

  it("says it is not connected instead of showing data when no source is configured", () => {
    window.location.hash = "#issues";
    render(<App demo={false} source={null} />);
    expect(screen.getByRole("alert").textContent).toBe(NOT_CONNECTED_STATE);
    expect(screen.queryByText("Demo")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it.each([
    "#estate",
    "#inventory",
    "#issues",
    "#recovery",
    "#lifecycle",
    "#scans",
    "#blind-spots",
  ])("labels a real organisation's data without the Demo label on %s", async (hash) => {
    window.location.hash = hash;
    render(<App source={{ ...demoSource(), mode: "api" }} />);
    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.queryByText(DEMO_LABEL)).toBeNull();
  });

  it("shows the Demo label only for a demo source", async () => {
    render(<App source={demoSource()} />);
    expect(await screen.findByText(DEMO_LABEL)).toBeTruthy();
  });

  it("requests the scan history once while visiting every screen that shows the last scan", async () => {
    const scans = vi.fn(demoSource().scans);
    window.location.hash = "#estate";
    render(<App source={{ ...demoSource(), scans }} />);
    for (const hash of [
      "#estate",
      "#inventory",
      "#issues",
      "#recovery",
      "#lifecycle",
      "#blind-spots",
    ]) {
      window.location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      expect(await screen.findByText(/Last scan started/)).toBeTruthy();
    }
    expect(scans).toHaveBeenCalledTimes(1);
  });

  it("refreshes the scan history when Scans is opened after other screens", async () => {
    const scans = vi.fn(demoSource().scans);
    window.location.hash = "#estate";
    render(<App source={{ ...demoSource(), scans }} />);
    await screen.findByText(/Last scan started/);
    window.location.hash = "#scans";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await screen.findByRole("row", { name: /scan-1/ });
    await waitFor(() => expect(scans).toHaveBeenCalledTimes(2));
  });

  it("lists every planned destination", () => {
    render(<App demo />);
    const nav = screen.getByRole("navigation", { name: PRODUCT_NAME });
    for (const item of SHELL_NAV) {
      expect(nav.textContent).toContain(item);
    }
  });

  it("marks only the open destination as the current page", () => {
    window.location.hash = "#issues/disk-unattached";
    render(<App demo />);
    const nav = screen.getByRole("navigation", { name: PRODUCT_NAME });
    expect(within(nav).getByRole("link", { name: "Issues" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Scans" }).hasAttribute("aria-current")).toBe(
      false,
    );
  });

  it("marks Estate current at the bare hash", () => {
    render(<App demo />);
    expect(document.querySelector("[aria-current]")?.textContent).toBe("Estate");
  });

  it("marks Cost and waste as coming soon instead of linking to a dead page", () => {
    render(<App demo />);
    const nav = screen.getByRole("navigation", { name: PRODUCT_NAME });
    expect(within(nav).queryByRole("link", { name: /Cost and waste/ })).toBeNull();
    expect(within(nav).getByText("coming soon")).toBeTruthy();
  });

  it.each(["#nope", "#estate/extra", "#cost-and-waste"])(
    "shows a not-found view with a way back for %s",
    async (hash) => {
      window.location.hash = hash;
      const { container } = render(<App demo />);
      expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
      await waitFor(() => expect(document.title).toBe("Page not found - Farside"));
      expect(screen.getByRole("link", { name: "Go to Estate" }).getAttribute("href")).toBe(
        "#estate",
      );
      expect(screen.getByRole("navigation", { name: PRODUCT_NAME })).toBeTruthy();
      await expectAxeClean(container);
    },
  );

  it("focuses the not-found heading when navigating to an unknown detail path", async () => {
    window.location.hash = "#estate";
    render(<App demo />);
    await screen.findByRole("heading", { name: "Estate" });
    window.location.hash = "#estate/extra";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const heading = await screen.findByRole("heading", { name: "Page not found" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("opens Connect from the hash", async () => {
    window.location.hash = "#connect";
    render(<App demo />);
    expect(await screen.findByRole("heading", { name: "Connect Azure" })).toBeTruthy();
  });

  it("changes the title, aria-current and focus when navigating hashes", async () => {
    window.location.hash = "#issues";
    render(<App demo />);
    expect(await screen.findByRole("heading", { name: "Issues" })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Issues - Farside"));
    const nav = screen.getByRole("navigation", { name: PRODUCT_NAME });
    expect(within(nav).getByRole("link", { name: "Issues" }).getAttribute("aria-current")).toBe(
      "page",
    );

    window.location.hash = "#scans";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "Scans" })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Scans - Farside"));
    expect(within(nav).getByRole("link", { name: "Scans" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("page-title");
    });

    window.location.hash = "#issues/disk-unattached";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "disk-unattached" })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Issues - Farside"));
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("issue-detail-title");
    });
  });
});
