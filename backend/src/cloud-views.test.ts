import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { fixtureCommitmentClient } from "./commitments.js";
import { fixtureCostClient } from "./cost.js";
import { inventoryFromGcpManifest, type GcpGroundTruthManifest } from "./gcp-inventory.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";
import { fixedClock, TEST_APP_OPTIONS } from "./test-clock.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const AZURE = JSON.parse(
  readFileSync(join(root, "docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;
const GCP = JSON.parse(
  readFileSync(join(root, "docs/gcp/ground-truth.json"), "utf8"),
) as GcpGroundTruthManifest;
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("export of the inventory covers every cloud", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, TEST_APP_OPTIONS);
  afterAll(() => app.close());

  const azure = inventoryFromManifest(AZURE);
  const gcp = inventoryFromGcpManifest(GCP);

  const put = (payload: unknown) =>
    app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: payload as object,
    });
  const exported = (query = "") =>
    app.inject({ method: "GET", url: `/v1/orgs/org-a/export/inventory${query}`, headers: ORG });

  it("is just that cloud's rows for an org with one cloud, as before", async () => {
    await put(azure);
    const response = await exported();
    expect(response.json().rows).toHaveLength(azure.resources.length);
    expect(new Set(response.json().rows.map((row: { cloud: string }) => row.cloud))).toEqual(
      new Set(["azure"]),
    );
  });

  it("holds the rows of both clouds with no cloud given, and one cloud's with ?cloud=", async () => {
    await put(gcp);
    const all = (await exported()).json().rows as Array<{ cloud: string }>;
    expect(all).toHaveLength(azure.resources.length + gcp.resources.length);
    expect(new Set(all.map((row) => row.cloud))).toEqual(new Set(["azure", "gcp"]));

    const onlyGcp = (await exported("?cloud=gcp")).json().rows as Array<{ cloud: string }>;
    expect(onlyGcp).toHaveLength(gcp.resources.length);
    expect(onlyGcp.every((row) => row.cloud === "gcp")).toBe(true);
    const onlyAzure = (await exported("?cloud=azure")).json().rows as Array<{ cloud: string }>;
    expect(onlyAzure).toHaveLength(azure.resources.length);
  });
});

describe("cost-waste scoped to a cloud", () => {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, {
    ...TEST_APP_OPTIONS,
    costClient: fixtureCostClient(),
    commitmentClient: fixtureCommitmentClient(),
  });

  beforeAll(async () => {
    await store.putConnection("org-a", { tenantId: "tenant-1", subscriptionId: "main" });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/commitments",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
  });
  afterAll(() => app.close());

  const view = async (query: string) =>
    (
      await app.inject({ method: "GET", url: `/v1/orgs/org-a/cost-waste${query}`, headers: ORG })
    ).json();

  it("shows the Azure spend and commitments with no cloud, and for azure", async () => {
    for (const query of ["", "?cloud=azure"]) {
      const body = await view(query);
      expect(body.spend.services.length).toBeGreaterThan(0);
      expect(body.commitments.reservations.length).toBeGreaterThan(0);
    }
  });

  it("shows no Azure spend, commitments or floor under gcp", async () => {
    const body = await view("?cloud=gcp");
    expect(body.spend?.services ?? []).toEqual([]);
    expect(body.commitments?.reservations ?? []).toEqual([]);
    expect(body.floorBurst ?? []).toEqual([]);
  });
});
