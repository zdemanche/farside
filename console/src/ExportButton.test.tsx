import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiSource } from "./data/api";
import { ExportButton } from "./ExportButton";
import { Issues } from "./Issues";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

describe("ExportButton", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    URL.createObjectURL = vi.fn(() => "blob:export");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("is hidden when the source cannot export (demo mode)", () => {
    renderScreen(<Issues hash="issues" />);
    expect(screen.queryByRole("button", { name: "Export issues" })).toBeNull();
  });

  it("downloads the file the source returns, and is axe clean", async () => {
    const exportFile = vi.fn(async () => ({
      filename: "farside-issues.json",
      content: '{"schema":"farside-export/1"}',
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { container } = renderScreen(
      <ExportButton kind="issues" label="Export issues" />,
      sourceWith({ exportFile }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export issues" }));
    await waitFor(() => expect(screen.getByText("Downloaded farside-issues.json")).toBeTruthy());
    expect(exportFile).toHaveBeenCalledWith("issues");
    expect(click).toHaveBeenCalledOnce();
    await expectAxeClean(container);
  });

  it("says why the export failed instead of downloading nothing", async () => {
    const { DataError } = await import("./data/error");
    renderScreen(
      <ExportButton kind="cost" label="Export cost" />,
      sourceWith({
        exportFile: async () => {
          throw new DataError("failed", 500, "boom");
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export cost" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/export cost/i));
  });
});

describe("apiSource.exportFile", () => {
  it("reads the attachment filename and body", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="farside-inventory-1.json"' },
        }),
    );
    const source = apiSource({ baseUrl: "http://x", orgId: "o", fetch });
    expect(await source.exportFile?.("inventory")).toEqual({
      filename: "farside-inventory-1.json",
      content: '{"ok":true}',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("http://x/v1/orgs/o/export/inventory");
  });
});
