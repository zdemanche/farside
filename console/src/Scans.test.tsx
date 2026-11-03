import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataError } from "./data/error";
import type { ScanRow } from "./data/types";
import { Scans } from "./Scans";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

const RUNNING: ScanRow = {
  id: "scan-3",
  subscriptionId: "main",
  status: "running",
  complete: false,
  current: false,
  startedAt: "2026-10-16T12:00:00.000Z",
  durationMs: null,
  error: null,
  coverageSummary: { assessed: 0, unassessed: 0, undetermined: 0 },
  checks: [],
};

describe("Scans screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
  });

  afterEach(() => {
    cleanup();
  });

  it("lists start time, duration, status and coverage, and hides current on a failed scan", async () => {
    const { container } = renderScreen(<Scans hash="scans" />);
    expect(screen.getByRole("heading", { name: "Scans" })).toBeTruthy();
    const current = await screen.findByRole("row", { name: /scan-1/ });
    expect(screen.getByRole("status").textContent).toBe("2 scans");
    expect(current.textContent).toContain("2026-10-14T12:00:00.000Z");
    expect(current.textContent).toContain("1.2 s");
    expect(current.textContent).toContain("succeeded current");
    expect(current.textContent).toContain("15 assessed, 4 unassessed, 1 undetermined");
    const failed = screen.getByRole("row", { name: /scan-2/ });
    expect(failed.textContent).toContain("failed");
    expect(failed.textContent).toContain("Resource Graph call failed");
    expect(failed.textContent).not.toContain("current");
    expect(current.querySelector(".chip-good")?.textContent).toBe("succeeded");
    expect(failed.querySelector(".chip-crit")?.textContent).toBe("failed");
    await expectAxeClean(container);
  });

  it("shows per-check results for the selected scan", async () => {
    const { container } = renderScreen(<Scans hash="scans/scan-1" />);
    expect(await screen.findByRole("heading", { name: "scan-1" })).toBeTruthy();
    expect(screen.getByText(/Status succeeded current/)).toBeTruthy();
    expect(screen.getByRole("row", { name: /azure-waste-unattached-disks/ }).textContent).toContain(
      "assessed",
    );
    expect(screen.getByRole("row", { name: /azure-cost-reservation-use/ }).textContent).toMatch(
      /undetermined/,
    );
    expect(screen.getByRole("row", { name: /azure-cost-spend-by-service/ }).textContent).toMatch(
      /unassessed/,
    );
    expect(screen.getByText(/Azure throttled the API call/)).toBeTruthy();
    await expectAxeClean(container);
  });

  it("shows a failed scan without marking it current", async () => {
    renderScreen(<Scans hash="scans/scan-2" />);
    expect(await screen.findByText(/Failed Resource Graph call failed/)).toBeTruthy();
    expect(screen.getByText(/Status failed/)).toBeTruthy();
    expect(screen.queryByText(/Status failed current/)).toBeNull();
  });

  it("says a missing scan does not exist", async () => {
    renderScreen(<Scans hash="scans/nope" />);
    expect(await screen.findByText("That scan does not exist.")).toBeTruthy();
  });

  it("polls a running scan until it finishes", async () => {
    const finished: ScanRow = { ...RUNNING, status: "succeeded", complete: true, current: true };
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockResolvedValue([finished]);
    renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Running"));
    expect(screen.getByRole("row", { name: /scan-3/ }).textContent).not.toContain("current");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 scans"));
    expect(screen.getByRole("row", { name: /scan-3/ }).textContent).toContain("succeeded current");
    expect(scans).toHaveBeenCalledTimes(2);
  });

  it("shows a poll failure as an alert instead of staying silent", async () => {
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockRejectedValue(new DataError("failed", 503, "503 Service Unavailable"));
    renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/503/);
  });

  it("stops polling when the screen unmounts", async () => {
    const scans = vi.fn<() => Promise<ScanRow[]>>().mockResolvedValue([RUNNING]);
    const { unmount } = renderScreen(<Scans hash="scans" pollMs={10} />, sourceWith({ scans }));
    await waitFor(() => expect(scans.mock.calls.length).toBeGreaterThanOrEqual(2));
    unmount();
    const calls = scans.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(scans).toHaveBeenCalledTimes(calls);
  });

  it("backs off between polls", async () => {
    const scans = vi.fn<() => Promise<ScanRow[]>>().mockResolvedValue([RUNNING]);
    renderScreen(<Scans hash="scans" pollMs={10} />, sourceWith({ scans }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(scans.mock.calls.length).toBeLessThan(8);
  });
});
