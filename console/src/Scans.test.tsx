import { act, cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { Scans } from "./Scans";
import { RUNNING_SCAN, SCAN_ROWS } from "./scans";

describe("Scans screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
    window.location.hash = "#scans";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
    vi.useRealTimers();
  });

  it("lists start time, duration, status and coverage, and hides current on a failed scan", async () => {
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "Scans" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("2 scans");
    const current = screen.getByRole("row", { name: /scan-1/ });
    expect(current.textContent).toContain("1970-01-01T00:00:00.000Z");
    expect(current.textContent).toContain("1.2 s");
    expect(current.textContent).toContain("succeeded current");
    expect(current.textContent).toContain("2 assessed, 1 unassessed, 1 undetermined");
    const failed = screen.getByRole("row", { name: /scan-2/ });
    expect(failed.textContent).toContain("failed");
    expect(failed.textContent).toContain("Resource Graph call failed");
    expect(failed.textContent).not.toContain("current");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    cleanup();
    window.location.hash = "#scans/scan-1";
    const detail = render(<App />);
    expect(screen.getByRole("heading", { name: "scan-1" })).toBeTruthy();
    expect(screen.getByText(/Status succeeded current/)).toBeTruthy();
    expect(screen.getByRole("row", { name: /azure-waste-unattached-disks/ }).textContent).toContain(
      "assessed",
    );
    expect(screen.getByRole("row", { name: /azure-waste-idle-load-balancers/ }).textContent).toMatch(
      /undetermined/,
    );
    expect(screen.getByRole("row", { name: /azure-cost-spend-by-service/ }).textContent).toMatch(
      /unassessed/,
    );
    expect(screen.getByText(/No metric series for the window/)).toBeTruthy();
    const detailResults = await axe.run(detail.container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(detailResults.violations).toEqual([]);
    cleanup();
    window.location.hash = "#scans/scan-2";
    render(<App />);
    expect(screen.getByText(/Failed Resource Graph call failed/)).toBeTruthy();
    expect(screen.getByText(/Status failed/)).toBeTruthy();
    expect(screen.queryByText(/Status failed current/)).toBeNull();
  });

  it("updates a running scan without a page reload", async () => {
    vi.useFakeTimers();
    render(<Scans scans={[...SCAN_ROWS, RUNNING_SCAN]} progressDelayMs={20} />);
    expect(screen.getByRole("status").textContent).toBe("Harvesting inventory");
    expect(screen.getByRole("row", { name: /scan-3/ }).textContent).toContain("running");
    expect(screen.getByRole("row", { name: /scan-3/ }).textContent).not.toContain("current");
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(screen.getByRole("status").textContent).toBe("3 scans");
    expect(screen.getByRole("row", { name: /scan-3/ }).textContent).toContain("succeeded current");
    expect(screen.getByRole("row", { name: /scan-1/ }).textContent).not.toContain("current");
  });
});
