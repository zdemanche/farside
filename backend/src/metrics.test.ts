import { describe, expect, it } from "vitest";
import { COVERAGE_CAUSES } from "./causes.js";
import { factsFromManifest } from "./facts.js";
import type { GroundTruthManifest } from "./inventory.js";
import {
  IDLE_LOAD_BALANCERS,
  IDLE_NAT_GATEWAYS,
  METRIC_WINDOW,
  fixtureMetricsClient,
  harvestMetrics,
  missingMonitoringRoleClient,
} from "./metrics.js";
import docAzureGroundTruth from "../../docs/azure/ground-truth.json" with { type: "json" };

const MANIFEST = docAzureGroundTruth as GroundTruthManifest;
const FACTS = factsFromManifest(MANIFEST);

describe("metrics harvest", () => {
  it("returns ByteCount totals only for load balancers and NAT gateways", async () => {
    const harvested = await harvestMetrics({
      client: fixtureMetricsClient(),
      subscriptionId: "main",
      facts: FACTS,
    });
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) {
      return;
    }
    expect(harvested.aggregates.every((row) => row.metricName === "ByteCount" && row.aggregation === "Total")).toBe(
      true,
    );
    expect(harvested.aggregates.every((row) => row.window === METRIC_WINDOW)).toBe(true);
    expect(harvested.aggregates.map((row) => row.resourceUri).sort()).toEqual(
      FACTS.filter(
        (fact) =>
          fact.resourceUri.includes("loadBalancers") || fact.resourceUri.includes("natGateways"),
      )
        .map((fact) => fact.resourceUri)
        .sort(),
    );
    const idleLb = harvested.aggregates.find((row) => row.resourceUri.endsWith("/lb-idle"));
    const busyLb = harvested.aggregates.find((row) => row.resourceUri.endsWith("/lb-busy"));
    expect(idleLb?.value).toBe(0);
    expect(busyLb?.value).toBe(1000);
    expect(harvested.facts.find((fact) => fact.resourceUri.endsWith("/lb-idle"))?.fields).toMatchObject({
      metricWindow: METRIC_WINDOW,
      byteCount: 0,
    });
    expect(
      harvested.coverage.filter((entry) => entry.checkId === IDLE_LOAD_BALANCERS || entry.checkId === IDLE_NAT_GATEWAYS),
    ).toHaveLength(2);
  });

  it("marks idle checks unassessed when Monitoring Reader is missing", async () => {
    const harvested = await harvestMetrics({
      client: missingMonitoringRoleClient(),
      subscriptionId: "main",
      facts: FACTS,
    });
    expect(harvested).toMatchObject({ ok: false, reason: "missing_role" });
    if (harvested.ok) {
      return;
    }
    expect(harvested.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: IDLE_LOAD_BALANCERS,
          state: "unassessed",
          causeId: "missing_role",
          reason: COVERAGE_CAUSES.missing_role.reason,
        }),
        expect.objectContaining({
          checkId: IDLE_NAT_GATEWAYS,
          state: "unassessed",
          causeId: "missing_role",
        }),
      ]),
    );
  });
});
