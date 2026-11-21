import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
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

const apps: Array<ReturnType<typeof buildApp>> = [];

function fresh(options: Parameters<typeof buildApp>[1] = TEST_APP_OPTIONS) {
  const store = new MemoryStore(fixedClock);
  const app = buildApp(store, options);
  apps.push(app);
  return { store, app };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("export of the inventory covers every cloud", () => {
  const azure = inventoryFromManifest(AZURE);
  const gcp = inventoryFromGcpManifest(GCP);

  const put = (app: ReturnType<typeof buildApp>, payload: unknown) =>
    app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/inventory",
      headers: ORG,
      payload: payload as object,
    });
  const exported = (app: ReturnType<typeof buildApp>, query = "") =>
    app.inject({ method: "GET", url: `/v1/orgs/org-a/export/inventory${query}`, headers: ORG });

  it("is just that cloud's rows for an org with one cloud, as before", async () => {
    const { app } = fresh();
    await put(app, azure);
    const response = await exported(app);
    expect(response.json().rows).toHaveLength(azure.resources.length);
    expect(new Set(response.json().rows.map((row: { cloud: string }) => row.cloud))).toEqual(
      new Set(["azure"]),
    );
  });

  it("holds the rows of both clouds with no cloud given, and one cloud's with ?cloud=", async () => {
    const { app } = fresh();
    await put(app, azure);
    await put(app, gcp);
    const all = (await exported(app)).json().rows as Array<{ cloud: string }>;
    expect(all).toHaveLength(azure.resources.length + gcp.resources.length);
    expect(new Set(all.map((row) => row.cloud))).toEqual(new Set(["azure", "gcp"]));

    const onlyGcp = (await exported(app, "?cloud=gcp")).json().rows as Array<{ cloud: string }>;
    expect(onlyGcp).toHaveLength(gcp.resources.length);
    expect(onlyGcp.every((row) => row.cloud === "gcp")).toBe(true);
    const onlyAzure = (await exported(app, "?cloud=azure")).json().rows as Array<{ cloud: string }>;
    expect(onlyAzure).toHaveLength(azure.resources.length);
  });
});

describe("cost-waste for another cloud is unchanged: still readable when the org has Azure cost", () => {
  it("answers the same for ?cloud=gcp as for no cloud, with readable true, once Azure cost is stored", async () => {
    const { app, store } = fresh({ ...TEST_APP_OPTIONS, costClient: fixtureCostClient() });
    await store.putConnection("org-a", { tenantId: "tenant-1", subscriptionId: "main" });
    const stored = await app.inject({
      method: "POST",
      url: "/v1/orgs/org-a/cost",
      headers: ORG,
      payload: { subscriptionId: "main" },
    });
    expect(stored.statusCode).toBeLessThan(300);
    const gcp = (
      await app.inject({ method: "GET", url: "/v1/orgs/org-a/cost-waste?cloud=gcp", headers: ORG })
    ).json();
    const all = (
      await app.inject({ method: "GET", url: "/v1/orgs/org-a/cost-waste", headers: ORG })
    ).json();
    // The console hides Azure spend under GCP itself, and shows the GCP waste list only when readable is true.
    expect(gcp.readable).toBe(true);
    expect(all.readable).toBe(true);
  });
});
