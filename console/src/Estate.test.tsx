import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataError } from "./data/error";
import { Estate } from "./Estate";
import { Inventory } from "./Inventory";
import { Settings } from "./Settings";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

const EMPTY_OVERVIEW = {
  empty: true,
  resourceTotal: 0,
  noOwnerTotal: 0,
  coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
  healthScore: null,
};

describe("Estate, Inventory and Settings", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("points an empty overview to Connect and hides a health score", async () => {
    const { container } = renderScreen(
      <Estate />,
      sourceWith({ overview: async () => EMPTY_OVERVIEW }),
    );
    expect(await screen.findByRole("link", { name: "Connect a cloud estate" })).toHaveProperty(
      "hash",
      "#connect",
    );
    expect(screen.queryByText(/health score \d/i)).toBeNull();
    await expectAxeClean(container);
  });

  it("shows seeded totals, coverage and a health score from assessed scopes only", async () => {
    const { container } = renderScreen(<Estate />);
    expect(await screen.findByText("Resources 4")).toBeTruthy();
    expect(screen.getByText("No owner 1")).toBeTruthy();
    expect(screen.getByText("Assessed scopes 15")).toBeTruthy();
    expect(screen.getByText("Not assessed scopes 4")).toBeTruthy();
    expect(screen.getByText("Undetermined results 1")).toBeTruthy();
    expect(screen.getByText("Health score 13")).toBeTruthy();
    await expectAxeClean(container);
  });

  const resourceCount = (text: string) =>
    waitFor(() => expect(screen.getByText(/\d+ resources?$/).textContent).toBe(text));

  it.each([
    ["Owner", "none", "1 resource", /Unattached managed disk/],
    ["Service", "Microsoft.Compute/disks", "2 resources", /Unattached managed disk/],
    ["Subscription", "empty-no-budget", "1 resource", undefined],
    ["Region", "westus", "1 resource", /Production VM/],
  ] as const)("filters inventory by %s", async (label, value, total, row) => {
    renderScreen(<Inventory />);
    await resourceCount("4 resources");
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    await resourceCount(total);
    if (row) {
      expect(screen.getByRole("row", { name: row })).toBeTruthy();
    }
  });

  it("explains a filter that matches nothing and restores every resource on Clear filters", async () => {
    const { container } = renderScreen(<Inventory />);
    await resourceCount("4 resources");
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "westus" } });
    await resourceCount("0 resources");
    expect(screen.getByText(/No resources match these filters/)).toBeTruthy();
    await expectAxeClean(container);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await resourceCount("4 resources");
  });

  it("says part of the inventory is unassessed when scopes were not assessed", async () => {
    renderScreen(<Inventory />);
    expect(await screen.findByText(/Partial: 5 scopes not assessed/)).toBeTruthy();
  });

  it("saves settings through the source and keeps the fields the form does not show", async () => {
    const saveSettings = vi.fn(async (next) => next);
    const { container } = renderScreen(<Settings />, sourceWith({ saveSettings }));
    fireEvent.change(await screen.findByLabelText("Owner tag key"), {
      target: { value: "cost-center" },
    });
    fireEvent.change(screen.getByLabelText("Snapshot retention days"), {
      target: { value: "45" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/cost-center/));
    expect(screen.getByRole("status").textContent).toMatch(/^Saved for this demo session only\./);
    expect(screen.getByRole("status").textContent).toMatch(/45 days/);
    expect(screen.getByRole("status").textContent).toMatch(/next scan/);
    expect(saveSettings.mock.calls[0]?.[0]).toMatchObject({
      ownerTagKey: "cost-center",
      snapshotRetentionDays: 45,
      certExpiryFlagDays: 60,
    });
    fireEvent.change(screen.getByLabelText("Scan interval hours"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/12-hour schedule/));
    await expectAxeClean(container);
  });

  it("reports a failed save instead of claiming success", async () => {
    const saveSettings = vi.fn().mockRejectedValue(new DataError("denied", 403, "403 Forbidden"));
    renderScreen(<Settings />, sourceWith({ saveSettings }));
    await screen.findByLabelText("Owner tag key");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/doesn't have access/);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("filters a uksouth resource owned by acme and shows org and subscription", async () => {
    const acme = {
      resourceUri:
        "/subscriptions/sub-acme/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-acme",
      resourceType: "Microsoft.Compute/virtualMachines",
      region: "uksouth",
      displayName: "Acme VM",
      tags: { owner: "acme" },
      ownerTag: "acme",
      subscriptionOrProject: "sub-acme",
      cloud: "azure" as const,
    };
    renderScreen(<Inventory />, sourceWith({ inventory: async () => [acme] }));
    expect(await screen.findByText(/Org demo/)).toBeTruthy();
    expect(screen.getByText(/Subscription sub-acme/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "uksouth" } });
    expect(screen.getByRole("row", { name: /Acme VM/ })).toBeTruthy();
    expect(screen.getByText("1 resource")).toBeTruthy();
  });

  it("reads the project from a typed browse field for the column and the filter", async () => {
    const gcp = {
      resourceUri: "//compute.googleapis.com/projects/proj-9/zones/us-east1-b/disks/pd-1",
      resourceType: "compute.googleapis.com/Disk",
      region: "us-east1",
      displayName: "GCP disk",
      tags: {},
      ownerTag: null,
      subscriptionOrProject: "proj-9",
      cloud: "gcp" as const,
    };
    renderScreen(<Inventory />, sourceWith({ inventory: async () => [gcp] }));
    const row = await screen.findByRole("row", { name: /GCP disk/ });
    expect(row.textContent).toContain("proj-9");
    fireEvent.change(screen.getByLabelText("Subscription"), { target: { value: "proj-9" } });
    expect(screen.getByRole("row", { name: /GCP disk/ })).toBeTruthy();
  });

  it("says coverage is unknown when the overview cannot load", async () => {
    renderScreen(
      <Inventory />,
      sourceWith({ overview: () => Promise.reject(new DataError("failed", 500, "500 Boom")) }),
    );
    expect(await screen.findByText(/Coverage unknown/)).toBeTruthy();
  });

  it("fetches the overview once for the whole provider", async () => {
    const overview = vi.fn(async () => EMPTY_OVERVIEW);
    renderScreen(<Inventory />, sourceWith({ overview }));
    await screen.findByText(/\d+ resources?$/);
    expect(overview).toHaveBeenCalledTimes(1);
  });
});
