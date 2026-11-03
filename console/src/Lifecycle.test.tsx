import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LifecycleRow } from "./data/types";
import { Lifecycle } from "./Lifecycle";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

const NEVER_SCANNED = {
  empty: true,
  resourceTotal: 0,
  noOwnerTotal: 0,
  coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
  healthScore: null,
};

const ROWS: LifecycleRow[] = [
  {
    id: "a",
    resourceId: "vm-a",
    date: "2026-12-01",
    kind: "sku",
    title: "Standard_A1",
    source: { vendor: "Microsoft Azure", href: "https://learn.microsoft.com/retire" },
  },
  {
    id: "b",
    resourceId: "cert-b",
    date: "2027-06-30",
    kind: "certificate",
    title: "cert-b",
    source: { vendor: "Google Cloud" },
  },
];

const withRows = (rows: LifecycleRow[], within90: number) =>
  sourceWith({ lifecycle: async () => ({ rows, within90 }) });

describe("Lifecycle screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the date, item, kind and source of each row in the order given", async () => {
    const { container } = renderScreen(<Lifecycle />, withRows(ROWS, 1));
    const table = await screen.findByRole("table", { name: "Lifecycle items by date" });
    const [first, second] = within(table).getAllByRole("row").slice(1);
    expect(first?.textContent).toBe("1 Dec 2026Standard_A1skuMicrosoft Azure");
    expect(second?.textContent).toBe("30 Jun 2027cert-bcertificateGoogle Cloud");
    expect(first?.querySelector("time")?.getAttribute("datetime")).toBe("2026-12-01");
    await expectAxeClean(container);
  });

  it("links the item to Inventory and the source only when it has a link", async () => {
    renderScreen(<Lifecycle />, withRows(ROWS, 1));
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: "Standard_A1" }).getAttribute("href")).toBe(
      "#inventory?resource=vm-a",
    );
    expect(within(table).getByRole("link", { name: "Microsoft Azure" }).getAttribute("href")).toBe(
      "https://learn.microsoft.com/retire",
    );
    expect(within(table).queryByRole("link", { name: "Google Cloud" })).toBeNull();
  });

  it("reports the source's count of things losing support in 90 days", async () => {
    renderScreen(<Lifecycle />, withRows(ROWS, 1));
    await screen.findByRole("table");
    expect(screen.getByRole("status").textContent).toBe("1 thing losing support in 90 days");
  });

  it("says not checked yet on a never-scanned org", async () => {
    renderScreen(
      <Lifecycle />,
      sourceWith({
        overview: async () => NEVER_SCANNED,
        lifecycle: async () => ({ rows: [], within90: 0 }),
      }),
    );
    expect(await screen.findByText(/Not checked yet/)).toBeTruthy();
    expect(screen.queryByText(/Nothing is losing support/)).toBeNull();
  });
});
