import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { apiSource } from "./data/api";
import { demoSource } from "./data/demo";

async function fixtureSentinels(): Promise<string[]> {
  const demo = demoSource();
  const [inventory, issues, scans, blind, recovery, lifecycle] = await Promise.all([
    demo.inventory(),
    demo.issues(),
    demo.scans(),
    demo.blindSpots(),
    demo.recovery(),
    demo.lifecycle(),
  ]);
  return [
    "disk-unattached",
    "vm-prod-no-backup",
    "scan-1",
    "Health score 13",
    "Resources 4",
    "Assessed scopes 15",
    "15 assessed",
    ...inventory.map((resource) => resource.displayName),
    ...issues.flatMap((issue) => [issue.id, issue.resourceId]),
    ...scans.map((scan) => scan.id),
    ...blind.spots.map((spot) => spot.checkId),
    ...recovery.rows.map((row) => row.system),
    ...lifecycle.rows.map((row) => row.title),
  ];
}

const PAYLOADS: Record<string, unknown> = {
  "/estate": {
    empty: true,
    resourceTotal: 0,
    noOwnerTotal: 0,
    coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
    healthScore: null,
  },
  "/issues": { issues: [] },
  "/scans": { scans: [] },
  "/findings": { findings: [] },
  "/blind-spots": {
    spots: [],
    health: { assessedScopes: 0, unassessedScopes: 0 },
    formula: "formula",
  },
  "/settings": {
    ownerTagKey: "owner",
    productionTagKey: "environment",
    productionTagValue: "prod",
    snapshotRetentionDays: 30,
    certExpiryFlagDays: 60,
    scanScheduleEnabled: true,
    scanIntervalHours: 24,
    scanRetryLimit: 3,
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockedFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace("https://farside.test/v1/orgs/org-1", "");
    const payload = PAYLOADS[path];
    return payload === undefined ? json({ title: "Not found" }, 404) : json(payload);
  });
}

const HASHES = [
  "",
  "estate",
  "inventory",
  "issues",
  "issues/disk-unattached",
  "recovery",
  "lifecycle",
  "scans",
  "scans/scan-1",
  "blind-spots",
  "settings",
  "connect",
];

describe("App against the API source", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it.each(HASHES)("shows no fixture data and no Demo label at #%s", async (hash) => {
    window.location.hash = `#${hash}`;
    const fetchMock = mockedFetch();
    const { container } = render(
      <App
        demo={false}
        source={apiSource({ baseUrl: "https://farside.test/", orgId: "org-1", fetch: fetchMock })}
      />,
    );
    await waitFor(() => expect(container.textContent).not.toMatch(/Loading /));
    const text = (container.textContent ?? "").replace(hash.split("/")[1] ?? "", "");
    for (const name of await fixtureSentinels()) {
      expect(text).not.toContain(name);
    }
    expect(text).not.toContain("Demo");
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>)["x-farside-org"]).toBe("org-1");
    }
  });
});

describe("apiSource", () => {
  const settings = PAYLOADS["/settings"];

  it("sends the org header and body to the backend routes", async () => {
    const fetchMock = vi.fn(async () => json(settings));
    const source = apiSource({ baseUrl: "https://farside.test", orgId: "org 1", fetch: fetchMock });
    await source.saveSettings(settings as never);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://farside.test/v1/orgs/org%201/settings");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["x-farside-org"]).toBe("org 1");
    expect(JSON.parse(init.body as string)).toEqual(settings);
  });

  it.each([
    [401, "unauthenticated"],
    [410, "gone"],
    [403, "denied"],
    [404, "not-found"],
    [503, "failed"],
  ])("maps HTTP %i to the %s error kind", async (status, kind) => {
    const source = apiSource({
      baseUrl: "https://farside.test",
      orgId: "org-1",
      fetch: vi.fn(async () => json({ title: "No" }, status)),
    });
    await expect(source.settings()).rejects.toMatchObject({ kind, status });
  });

  it("maps a network failure to a network error", async () => {
    const source = apiSource({
      baseUrl: "https://farside.test",
      orgId: "org-1",
      fetch: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    await expect(source.settings()).rejects.toMatchObject({ kind: "network", status: null });
  });

  it("treats an org with no inventory as empty and maps issues and findings", async () => {
    const source = apiSource({
      baseUrl: "https://farside.test",
      orgId: "org-1",
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/inventory/browse")) {
          return json({ title: "Not found" }, 404);
        }
        if (url.endsWith("/issues")) {
          return json({
            issues: [
              {
                id: "i-1",
                checkId: "azure-waste-unattached-disks",
                resourceId: "d-1",
                subscriptionOrProject: "sub-1",
                status: "open",
                evidence: { diskId: "d-1", sizeGb: 8 },
                savings: { min: "1.00", max: "2.00", currency: "USD" },
                coverage: "assessed",
                firstSeen: "t0",
                lastConfirmed: "t1",
              },
            ],
          });
        }
        return json({
          findings: [
            {
              checkId: "azure-resilience-prod-vms-outside-backup",
              result: "fail",
              evidence: { fields: { vmId: "vm-1", protected: false } },
              scope: { id: "sub-1:x", cloud: "azure", subscriptionOrProject: "sub-1" },
            },
          ],
        });
      }),
    });
    expect(await source.inventory()).toEqual([]);
    expect(await source.issues()).toEqual([
      expect.objectContaining({
        id: "i-1",
        subscription: "sub-1",
        evidence: "sizeGb 8",
        savings: { min: "1.00", max: "2.00", currency: "USD", period: "month" },
      }),
    ]);
    expect(await source.recovery()).toEqual({
      rows: [expect.objectContaining({ system: "vm-1", coverage: "assessed" })],
      unprotected: 1,
      checked: 1,
      undetermined: 0,
    });
  });
});
