import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataError } from "./data/error";
import type { ScanRow } from "./data/types";
import { Scans } from "./Scans";
import { scanErrorText } from "./terms";
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

const FINISHED: ScanRow = { ...RUNNING, status: "succeeded", complete: true, current: true };
const QUEUED: ScanRow = { ...RUNNING, id: "scan-4", status: "queued", startedAt: null };

function recordAnnouncements(region: HTMLElement): string[] {
  const texts: string[] = [region.textContent ?? ""];
  new MutationObserver(() => {
    const text = region.textContent ?? "";
    if (text !== texts[texts.length - 1]) {
      texts.push(text);
    }
  }).observe(region, { childList: true, characterData: true, subtree: true });
  return texts;
}

const liveRegion = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".page-meta[role='status']")!;

const timesAnnounced = (texts: string[], outcome: string) =>
  texts.filter((text, index) => text.includes(outcome) && !texts[index - 1]?.includes(outcome))
    .length;

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
    expect(current.textContent).toContain("14 Oct 2026, 12:00 UTC");
    expect(current.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-14T12:00:00.000Z",
    );
    expect(current.textContent).toContain("1.2 s");
    expect(current.textContent).toContain("succeeded current");
    expect(current.textContent).toContain(
      "15 assessed, 4 not assessed, 1 undetermined",
    );
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
    expect(
      screen.getByRole("row", { name: /azure-waste-unattached-disks/ })
        .textContent,
    ).toContain("assessed");
    expect(
      screen.getByRole("row", { name: /azure-cost-reservation-use/ })
        .textContent,
    ).toMatch(/undetermined/);
    expect(
      screen.getByRole("row", { name: /azure-cost-spend-by-service/ })
        .textContent,
    ).toMatch(/not assessed/);
    expect(screen.getByText(/Azure throttled the API call/)).toBeTruthy();
    await expectAxeClean(container);
  });

  it("shows a failed scan without marking it current", async () => {
    renderScreen(<Scans hash="scans/scan-2" />);
    expect(
      await screen.findByText(/Failed Resource Graph call failed/),
    ).toBeTruthy();
    expect(screen.getByText(/Status failed/)).toBeTruthy();
    expect(screen.queryByText(/Status failed current/)).toBeNull();
  });

  it("says a missing scan does not exist", async () => {
    renderScreen(<Scans hash="scans/nope" />);
    expect(
      await screen.findByRole("heading", { name: "Scan nope was not found" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("scan-detail-title"),
    );
  });

  it("polls a running scan until it finishes", async () => {
    const finished: ScanRow = {
      ...RUNNING,
      status: "succeeded",
      complete: true,
      current: true,
    };
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockResolvedValue([finished]);
    renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("scan-3 running"),
    );
    expect(
      screen
        .getByRole("region", { name: "Scan history" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(
      screen.getByRole("row", { name: /scan-3/ }).textContent,
    ).not.toContain("current");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("scan-3 succeeded"),
    );
    expect(
      screen
        .getByRole("region", { name: "Scan history" })
        .hasAttribute("aria-busy"),
    ).toBe(false);
    expect(screen.getByRole("row", { name: /scan-3/ }).textContent).toContain(
      "succeeded current",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scans).toHaveBeenCalledTimes(2);
  });

  it("announces a finished scan without first showing the scan count", async () => {
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockResolvedValue([FINISHED]);
    const { container } = renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    const region = liveRegion(container);
    const texts = recordAnnouncements(region);
    await waitFor(() => expect(region.textContent).toBe("scan-3 succeeded"));
    expect(texts).not.toContain("1 scan");
    expect(timesAnnounced(texts, "scan-3 succeeded")).toBe(1);
  });

  it("announces the first scan's outcome while a second scan is queued", async () => {
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockResolvedValueOnce([FINISHED, QUEUED])
      .mockResolvedValue([FINISHED, { ...QUEUED, status: "succeeded", complete: true }]);
    const { container } = renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    const region = liveRegion(container);
    const texts = recordAnnouncements(region);
    await waitFor(() => expect(region.textContent).toBe("scan-4 succeeded"));
    expect(texts).toContain("scan-3 succeeded; scan-4 queued");
    expect(timesAnnounced(texts, "scan-3 succeeded")).toBe(1);
    expect(timesAnnounced(texts, "scan-4 succeeded")).toBe(1);
  });

  it("announces a scan that finishes after a poll error and Retry", async () => {
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockRejectedValueOnce(new DataError("failed", 503, "503 Service Unavailable"))
      .mockResolvedValue([FINISHED]);
    const { container } = renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    const region = liveRegion(container);
    const texts = recordAnnouncements(region);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(region.textContent).toBe("scan-3 succeeded"));
    expect(timesAnnounced(texts, "scan-3 succeeded")).toBe(1);
  });

  it("keeps one live region mounted through a poll error", async () => {
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockRejectedValue(new DataError("failed", 503, "503 Service Unavailable"));
    const { container } = renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    const region = liveRegion(container);
    await screen.findByRole("alert");
    expect(liveRegion(container)).toBe(region);
  });

  it("names the scan and the plain-language reason when a polled scan fails", async () => {
    const failed: ScanRow = {
      ...RUNNING,
      status: "failed",
      error: "harvest_timeout",
      errorId: "err-42",
    };
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockResolvedValue([failed]);
    renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "scan-3 failed: The cloud estate didn't respond in time",
      ),
    );
    const row = screen.getByRole("row", { name: /scan-3/ });
    expect(row.textContent).toContain(
      "The cloud estate didn't respond in time (Reference err-42)",
    );
    expect(row.textContent).not.toContain("harvest_timeout");
  });

  it("explains the unconfigured-provider error with a link to Connect", async () => {
    const scans = vi.fn<() => Promise<ScanRow[]>>().mockResolvedValue([
      { ...RUNNING, status: "failed", error: "No cloud provider is configured" },
    ]);
    renderScreen(<Scans hash="scans" />, sourceWith({ scans }));
    const row = await screen.findByRole("row", { name: /scan-3/ });
    expect(row.textContent).toContain("No cloud is connected yet");
    expect(within(row).getByRole("link", { name: "Connect a cloud" }).getAttribute("href")).toBe("#connect");
    expect(scanErrorText("scan failed")).toBe("The scan failed");
  });

  it("maps known error codes and falls back to the raw value for unknown ones", () => {
    expect(scanErrorText("harvest_failed")).toBe(
      "Couldn't read the cloud estate",
    );
    expect(scanErrorText("scan_failed")).toBe("The scan failed");
    expect(scanErrorText("something_else")).toBe("something_else");
  });

  it("offers Retry when a poll fails", async () => {
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockRejectedValueOnce(
        new DataError("failed", 503, "503 Service Unavailable"),
      )
      .mockResolvedValue([{ ...RUNNING, status: "succeeded", current: true }]);
    renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("row", { name: /scan-3/ })).toBeTruthy();
  });

  it("shows a poll failure as an alert instead of staying silent", async () => {
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValueOnce([RUNNING])
      .mockRejectedValue(
        new DataError("failed", 503, "503 Service Unavailable"),
      );
    renderScreen(<Scans hash="scans" pollMs={20} />, sourceWith({ scans }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/503/);
  });

  it("stops polling when the screen unmounts", async () => {
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValue([RUNNING]);
    const { unmount } = renderScreen(
      <Scans hash="scans" pollMs={10} />,
      sourceWith({ scans }),
    );
    await waitFor(() =>
      expect(scans.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    unmount();
    const calls = scans.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(scans).toHaveBeenCalledTimes(calls);
  });

  it("backs off between polls", async () => {
    const scans = vi
      .fn<() => Promise<ScanRow[]>>()
      .mockResolvedValue([RUNNING]);
    renderScreen(<Scans hash="scans" pollMs={10} />, sourceWith({ scans }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(scans.mock.calls.length).toBeLessThan(8);
  });
});
