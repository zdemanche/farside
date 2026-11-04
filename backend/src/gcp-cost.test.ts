import { describe, expect, it } from "vitest";
import { GCP_TEST_PROJECT } from "./gcp-inventory.js";
import {
  GCP_COST_HARVEST_UNVERIFIED,
  GCP_SPEND_BY_SERVICE,
  addAmounts,
  fixtureBigQueryExportClient,
  fixtureGcpCostRows,
  harvestGcpCost,
  missingBillingExportRoleClient,
  readAllBigQueryExportPages,
} from "./gcp-cost.js";

describe("BigQuery export paging", () => {
  it("follows pageToken until every fixture export row is read", async () => {
    const expected = fixtureGcpCostRows();
    const client = fixtureBigQueryExportClient({ pageSize: 7 });
    const rows = await readAllBigQueryExportPages(client, GCP_TEST_PROJECT);
    expect(rows).toHaveLength(expected.length);
    expect(rows.length).toBeGreaterThan(7);
    expect(addAmounts(rows.map((row) => row.costAmount))).toBe(
      addAmounts(expected.map((row) => row.costAmount)),
    );
  });
});

describe("BigQuery spend aggregates", () => {
  it("stores spend by service and project and marks the harvest unverified", async () => {
    const client = fixtureBigQueryExportClient({ pageSize: 5 });
    const harvested = await harvestGcpCost({ client, projectId: GCP_TEST_PROJECT });
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) {
      return;
    }
    const compute = harvested.snapshot.services.find((row) => row.serviceName === "Compute Engine");
    const storage = harvested.snapshot.services.find((row) => row.serviceName === "Cloud Storage");
    const bigquery = harvested.snapshot.services.find((row) => row.serviceName === "BigQuery");
    expect(compute).toMatchObject({ projectId: GCP_TEST_PROJECT, currency: "USD", costAmount: "1040.00" });
    expect(storage).toMatchObject({ projectId: GCP_TEST_PROJECT, currency: "USD", costAmount: "600.00" });
    expect(bigquery).toMatchObject({ projectId: GCP_TEST_PROJECT, currency: "USD", costAmount: "20.00" });
    expect(harvested.snapshot.harvestStatus).toBe(GCP_COST_HARVEST_UNVERIFIED.harvestStatus);
    expect(harvested.snapshot.liveRunAt).toBeNull();
    expect(harvested.coverage.find((entry) => entry.checkId === GCP_SPEND_BY_SERVICE)?.state).toBe("assessed");
  });

  it("refuses mixed-currency export rows", async () => {
    const client = fixtureBigQueryExportClient({
      rows: [
        {
          date: "2026-11-01",
          projectId: GCP_TEST_PROJECT,
          serviceName: "Compute Engine",
          costAmount: "10.00",
          currency: "USD",
        },
        {
          date: "2026-11-02",
          projectId: GCP_TEST_PROJECT,
          serviceName: "Cloud Storage",
          costAmount: "8.00",
          currency: "EUR",
        },
      ],
    });
    const harvested = await harvestGcpCost({ client, projectId: GCP_TEST_PROJECT });
    expect(harvested.ok).toBe(false);
    if (harvested.ok) {
      return;
    }
    expect(harvested.reason).toBe("mixed_currency");
    expect(harvested.coverage.find((entry) => entry.checkId === GCP_SPEND_BY_SERVICE)?.state).toBe(
      "undetermined",
    );
  });

  it("marks spend unassessed when BigQuery access is missing", async () => {
    const harvested = await harvestGcpCost({
      client: missingBillingExportRoleClient(),
      projectId: GCP_TEST_PROJECT,
    });
    expect(harvested.ok).toBe(false);
    if (harvested.ok) {
      return;
    }
    expect(harvested.reason).toBe("missing_role");
    expect(harvested.coverage.find((entry) => entry.checkId === GCP_SPEND_BY_SERVICE)).toMatchObject({
      state: "unassessed",
      causeId: "missing_role",
    });
  });
});
