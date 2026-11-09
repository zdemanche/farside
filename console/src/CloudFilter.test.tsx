import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { apiSource } from "./data/api";
import { demoSource } from "./data/demo";

describe("cloud dimension", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    window.location.hash = "#inventory";
  });

  afterEach(() => {
    cleanup();
  });

  it("sends ?cloud= on every read when a cloud is chosen, and not otherwise", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"issues":[]}', { status: 200 }),
    );
    await apiSource({ baseUrl: "http://x", orgId: "o", cloud: "gcp", fetch }).issues();
    await apiSource({ baseUrl: "http://x", orgId: "o", fetch }).issues();
    expect(fetch.mock.calls[0]?.[0]).toBe("http://x/v1/orgs/o/issues?cloud=gcp");
    expect(fetch.mock.calls[1]?.[0]).toBe("http://x/v1/orgs/o/issues");
  });

  it("filters a screen export by cloud but never an all-clouds export", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );
    const source = apiSource({ baseUrl: "http://x", orgId: "o", cloud: "gcp", fetch });
    await source.exportFile?.("issues");
    await source.exportFile?.("issues", undefined, { allClouds: true });
    expect(fetch.mock.calls[0]?.[0]).toBe("http://x/v1/orgs/o/export/issues?cloud=gcp");
    expect(fetch.mock.calls[1]?.[0]).toBe("http://x/v1/orgs/o/export/issues");
  });

  it("reads the cloud of each stored issue", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          '{"issues":[{"id":"i","cloud":"gcp","checkId":"gcp-waste-unattached-disks","resourceId":"d","subscriptionOrProject":"p","status":"open","evidence":{},"coverage":"assessed","firstSeen":"","lastConfirmed":""}]}',
          { status: 200 },
        ),
    );
    const rows = await apiSource({ baseUrl: "http://x", orgId: "o", fetch }).issues();
    expect(rows[0]?.cloud).toBe("gcp");
  });

  it("filters demo inventory and issues to the chosen cloud", async () => {
    const all = await demoSource().issues();
    expect(all.length).toBeGreaterThan(0);
    expect(await demoSource("gcp").issues()).toEqual([]);
    expect((await demoSource("azure").issues()).length).toBe(all.length);
    const gcpResources = await demoSource("gcp").inventory();
    expect(gcpResources.every((row) => row.cloud === "gcp")).toBe(true);
  });

  it("shows a Cloud selector that re-reads the screen for the chosen cloud", async () => {
    render(<App demo />);
    const select = await screen.findByLabelText("Cloud");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All clouds", "Azure", "GCP"]);
    await screen.findByRole("columnheader", { name: "Cloud" });
    fireEvent.change(select, { target: { value: "gcp" } });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("gcp"));
    await waitFor(() => {
      const rows = screen.queryAllByRole("row");
      expect(rows.every((row) => !/\bAzure\b/.test(row.textContent ?? ""))).toBe(true);
    });
  });

  it.each(["lifecycle", "recovery"])(
    "labels the %s screen by cloud and drops Azure rows when GCP is chosen",
    async (route) => {
      window.location.hash = `#${route}`;
      render(<App demo />);
      await screen.findByRole("columnheader", { name: "Cloud" });
      const azureRows = screen
        .getAllByRole("row")
        .filter((row) => within(row).queryByRole("cell", { name: "Azure" }));
      expect(azureRows.length).toBeGreaterThan(0);
      fireEvent.change(screen.getByLabelText("Cloud"), { target: { value: "gcp" } });
      await waitFor(() => {
        const rows = screen.queryAllByRole("row");
        expect(rows.every((row) => !within(row).queryByRole("cell", { name: "Azure" }))).toBe(true);
      });
    },
  );
});
