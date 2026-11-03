import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { EMPTY_STATE, NOT_CONNECTED_STATE, PRODUCT_NAME, SHELL_NAV } from "./shell";

describe("console shell", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("renders the product name and empty state", async () => {
    render(<App demo />);
    expect(screen.getByRole("heading", { name: PRODUCT_NAME })).toBeTruthy();
    expect(await screen.findByText(EMPTY_STATE)).toBeTruthy();
  });

  it("says it is not connected instead of showing data when no source is configured", () => {
    window.location.hash = "#issues";
    render(<App demo={false} source={null} />);
    expect(screen.getByRole("alert").textContent).toBe(NOT_CONNECTED_STATE);
    expect(screen.queryByText("Demo")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
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

  it("marks no destination current on the empty state", () => {
    render(<App demo />);
    expect(document.querySelector("[aria-current]")).toBeNull();
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
    expect(document.title).toBe("Issues - Farside");
    const nav = screen.getByRole("navigation", { name: PRODUCT_NAME });
    expect(within(nav).getByRole("link", { name: "Issues" }).getAttribute("aria-current")).toBe(
      "page",
    );

    window.location.hash = "#scans";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "Scans" })).toBeTruthy();
    expect(document.title).toBe("Scans - Farside");
    expect(within(nav).getByRole("link", { name: "Scans" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("page-title");
    });

    window.location.hash = "#issues/disk-unattached";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "disk-unattached" })).toBeTruthy();
    expect(document.title).toBe("Issues - Farside");
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("issue-detail-title");
    });
  });
});
