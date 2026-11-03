import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlindSpots } from "./BlindSpots";
import { demoSource } from "./data/demo";
import { DataError } from "./data/error";
import type { DataSource } from "./data/types";
import { Estate } from "./Estate";
import { Inventory } from "./Inventory";
import { Issues } from "./Issues";
import { Lifecycle } from "./Lifecycle";
import { Recovery } from "./Recovery";
import { Scans } from "./Scans";
import { Settings } from "./Settings";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

type LoaderName =
  | "overview"
  | "inventory"
  | "issues"
  | "scans"
  | "blindSpots"
  | "recovery"
  | "lifecycle"
  | "settings";

type Case = {
  name: string;
  loader: LoaderName;
  screen: () => ReactElement;
  populated: RegExp | string;
  empty?: { value: unknown; message: RegExp };
};

const CASES: Case[] = [
  {
    name: "Estate",
    loader: "overview",
    screen: () => <Estate />,
    populated: "Resources 4",
    empty: {
      value: {
        empty: true,
        resourceTotal: 0,
        noOwnerTotal: 0,
        coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
        healthScore: null,
      },
      message: /Nothing scanned yet/,
    },
  },
  {
    name: "Inventory",
    loader: "inventory",
    screen: () => <Inventory />,
    populated: "Unattached managed disk",
    empty: { value: [], message: /No resources have been inventoried yet/ },
  },
  {
    name: "Issues",
    loader: "issues",
    screen: () => <Issues hash="issues" />,
    populated: "disk-unattached",
    empty: { value: [], message: /No issues have been recorded/ },
  },
  {
    name: "Scans",
    loader: "scans",
    screen: () => <Scans hash="scans" />,
    populated: "scan-1",
    empty: { value: [], message: /No scans have run yet/ },
  },
  {
    name: "Recovery",
    loader: "recovery",
    screen: () => <Recovery />,
    populated: /production systems lack backup/,
    empty: {
      value: { rows: [], unprotected: 0, production: 0 },
      message: /No backup or redundancy gaps were found/,
    },
  },
  {
    name: "Lifecycle",
    loader: "lifecycle",
    screen: () => <Lifecycle />,
    populated: /losing support in 90 days/,
    empty: {
      value: { rows: [], within90: 0 },
      message: /Nothing is losing support or expiring/,
    },
  },
  {
    name: "Blind spots",
    loader: "blindSpots",
    screen: () => <BlindSpots />,
    populated: /scopes were left out of the score/,
    empty: {
      value: { spots: [], leftOut: 0, total: 5, formula: "formula" },
      message: /Every scope was assessed/,
    },
  },
  {
    name: "Settings",
    loader: "settings",
    screen: () => <Settings />,
    populated: "Save settings",
  },
];

function failing(loader: LoaderName, error: DataError): DataSource {
  return sourceWith({ [loader]: () => Promise.reject(error) });
}

describe.each(CASES)("$name states", ({ loader, screen: view, populated, empty }) => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a loading status before the data arrives", () => {
    renderScreen(view(), sourceWith({ [loader]: () => new Promise(() => {}) }));
    expect(screen.getByRole("status").textContent).toMatch(/^Loading /);
  });

  it("shows an alert with a Retry that loads the data again", async () => {
    const real = demoSource()[loader].bind(demoSource()) as () => Promise<unknown>;
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new DataError("failed", 503, "503 Service Unavailable"))
      .mockImplementation(real);
    const { container } = renderScreen(view(), sourceWith({ [loader]: load }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/503 Service Unavailable/);
    await expectAxeClean(container);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(populated)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("names the role to request when access is denied", async () => {
    renderScreen(view(), failing(loader, new DataError("denied", 403, "403 Forbidden")));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/doesn't have access to this organisation/);
    expect(alert.textContent).not.toMatch(/Farside (Reader|Admin)/);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it.runIf(empty !== undefined)("explains an empty result", async () => {
    const { container } = renderScreen(
      view(),
      sourceWith({ [loader]: () => Promise.resolve(empty?.value) }),
    );
    expect(await screen.findByText(empty!.message)).toBeTruthy();
    await expectAxeClean(container);
  });
});
