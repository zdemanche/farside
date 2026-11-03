import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMoney } from "./format";
import { Inventory } from "./Inventory";
import { Lifecycle } from "./Lifecycle";
import { BlindSpots } from "./BlindSpots";
import { Recovery } from "./Recovery";
import { Settings } from "./Settings";
import { plural } from "./plural";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

const ACME = {
  resourceUri:
    "/subscriptions/sub-acme/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acme1",
  resourceType: "Microsoft.Storage/storageAccounts",
  region: "uksouth",
  displayName: "Acme storage",
  tags: { owner: "acme" },
  ownerTag: "acme",
  subscriptionOrProject: "sub-acme",
};

describe("console audit behaviours", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  afterEach(() => {
    cleanup();
  });

  it("builds Inventory filters from the data and filters to a uksouth record owned by acme", async () => {
    renderScreen(
      <Inventory hash="inventory" />,
      sourceWith({ inventory: async () => [ACME] }),
    );
    expect(await screen.findByText("1 resource")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Region"), {
      target: { value: "uksouth" },
    });
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "acme" },
    });
    expect(screen.getByRole("row", { name: /Acme storage/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Region"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "none" },
    });
    expect(screen.queryByRole("row", { name: /Acme storage/ })).toBeNull();
    expect(
      screen.getByRole("search", { name: "Filter inventory" }),
    ).toBeTruthy();
  });

  it("filters Inventory to one resource from a drill-through link and can clear it", async () => {
    renderScreen(<Inventory hash="inventory?resource=disk-unattached" />);
    expect(await screen.findByText("1 resource")).toBeTruthy();
    expect(
      screen.getByRole("row", { name: /Unattached managed disk/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all resources" }));
    expect(window.location.hash).toBe("#inventory");
    expect(screen.getByText("4 resources")).toBeTruthy();
  });

  it("matches a resource URI case-insensitively and a short name only without a slash", async () => {
    const upper = ACME.resourceUri.toUpperCase();
    renderScreen(
      <Inventory hash={`inventory?resource=${encodeURIComponent(upper)}`} />,
      sourceWith({ inventory: async () => [ACME] }),
    );
    expect(await screen.findByText("1 resource")).toBeTruthy();
    cleanup();
    renderScreen(
      <Inventory hash="inventory?resource=storageAccounts%2Facme1" />,
      sourceWith({ inventory: async () => [ACME] }),
    );
    expect(await screen.findByText(/No resources match/)).toBeTruthy();
  });

  it("links blind-spot closers by what they ask for", async () => {
    renderScreen(<BlindSpots />);
    const grant = await screen.findByRole("row", { name: /azure-cost-reservation-use/ });
    expect(within(grant).getByRole("link", { name: "Open Connect" })).toBeTruthy();
    const wait = screen.getByRole("row", { name: /azure-cost-spend-by-service/ });
    expect(within(wait).getByRole("link", { name: "Open Scans" }).getAttribute("href")).toBe("#scans");
  });

  it("pluralises counts", () => {
    expect(plural(1, "resource")).toBe("1 resource");
    expect(plural(0, "resource")).toBe("0 resources");
  });

  it("formats structured money with currency code and period", () => {
    expect(
      formatMoney({
        min: "8.00",
        max: "12.00",
        currency: "USD",
        period: "month",
      }),
    ).toMatch(/^USD.8\.00 to USD.12\.00 per month$/);
    expect(formatMoney(null)).toBe("no estimate");
  });

  it.each([
    ["Recovery", <Recovery key="r" />],
    ["Lifecycle", <Lifecycle key="l" />],
    ["Blind spots", <BlindSpots key="b" />],
    ["Inventory", <Inventory key="i" hash="inventory" />],
  ])("shows a Last scan time with a timezone on %s", async (_name, ui) => {
    renderScreen(ui);
    const line = await screen.findByText(/^Last scan/);
    expect(line.textContent).toBe("Last scan 14 Oct 2026, 12:00 UTC");
    expect(line.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-14T12:00:00.000Z",
    );
  });

  it("says no scan has finished when none succeeded", async () => {
    renderScreen(<Recovery />, sourceWith({ scans: async () => [] }));
    expect(await screen.findByText("No scan has finished yet.")).toBeTruthy();
  });

  it("links Recovery systems to Inventory", async () => {
    renderScreen(<Recovery />);
    const link = await screen.findByRole("link", { name: "vm-prod-no-backup" });
    expect(link.getAttribute("href")).toBe(
      "#inventory?resource=vm-prod-no-backup",
    );
  });

  it("rejects fractional and empty settings with inline errors and does not save", async () => {
    const saveSettings = vi.fn();
    const { container } = renderScreen(
      <Settings />,
      sourceWith({ saveSettings }),
    );
    const retention = await screen.findByLabelText("Snapshot retention days");
    expect(retention.getAttribute("step")).toBe("1");
    fireEvent.change(retention, { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("Owner tag key"), {
      target: { value: " " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(retention.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter a whole number of at least 1.").id).toBe(
      retention.getAttribute("aria-describedby"),
    );
    expect(
      screen.getByLabelText("Owner tag key").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(saveSettings).not.toHaveBeenCalled();
    expect(screen.queryByText(/Saved/)).toBeNull();
    await expectAxeClean(container);
  });

  it("keeps chip text on one line", () => {
    const css = readFileSync(
      join(import.meta.dirname, "styles", "console.css"),
      "utf8",
    );
    const chip = css.match(/\n\.chip \{[^}]*\}/)?.[0] ?? "";
    expect(chip).toContain("white-space: nowrap");
    expect(chip).not.toContain("overflow-wrap");
  });
});
