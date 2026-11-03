import type { Finding } from "@farside/scan-contracts";
import { describe, expect, it } from "vitest";
import { lifecycleFrom, recoveryFrom } from "./data/derive";

function finding(
  checkId: string,
  result: Finding["result"],
  fields: Finding["evidence"]["fields"],
): Finding {
  return {
    checkId,
    result,
    evidence: { fields },
    scope: { id: `s:${checkId}`, cloud: "azure", subscriptionOrProject: "s" },
  };
}

const BACKUP = "azure-resilience-prod-vms-outside-backup";

describe("recoveryFrom", () => {
  it("counts only pass and fail as checked and reports undetermined separately", () => {
    const view = recoveryFrom([
      finding(BACKUP, "fail", { vmId: "a", protected: false }),
      finding(BACKUP, "pass", { vmId: "b", protected: true }),
      finding(BACKUP, "undetermined", { vmId: "c", protected: null }),
      finding(BACKUP, "undetermined", { vmId: "d", protected: null }),
    ]);
    expect(view).toMatchObject({ unprotected: 1, checked: 2, undetermined: 2 });
    expect(view.rows.map((row) => row.coverage)).toEqual([
      "assessed",
      "undetermined",
      "undetermined",
    ]);
  });
});

describe("lifecycleFrom", () => {
  it("keeps GCP SQL and GKE support findings, dated from supportEnd", () => {
    const view = lifecycleFrom(
      [
        {
          ...finding("gcp-lifecycle-sql-gke-support", "fail", {
            resourceName: "orders-db",
            resourceKind: "cloudsql",
            version: "POSTGRES_12",
            supportEnd: "2026-11-14",
            source: "docs/gcp/support.json",
          }),
          scope: { id: "p:x", cloud: "gcp", subscriptionOrProject: "p" },
        },
      ],
      "2026-10-15T12:00:00.000Z",
    );
    expect(view.rows).toEqual([
      {
        id: "gcp-lifecycle-sql-gke-support:orders-db",
        resourceId: "orders-db",
        date: "2026-11-14",
        kind: "support",
        title: "orders-db",
        source: { vendor: "Google Cloud" },
      },
    ]);
    expect(view.within90).toBe(1);
  });

  it("dates GCP expiring certificates from expireTime and counts them", () => {
    const view = lifecycleFrom(
      [
        finding("gcp-lifecycle-expiring-certs", "fail", {
          certificateId: "cert-web",
          expireTime: "2026-11-20T00:00:00Z",
          daysRemaining: 36,
          flagDays: 60,
        }),
      ],
      "2026-10-15T12:00:00.000Z",
    );
    expect(view.rows.map((row) => row.date)).toEqual(["2026-11-20"]);
    expect(view.within90).toBe(1);
  });

  it("links the source only when the evidence gives an https url", () => {
    const [linked, bare] = lifecycleFrom(
      [
        finding("azure-lifecycle-retiring-skus", "fail", {
          resourceId: "a",
          retirementDate: "2026-12-01",
          sourceUrl: "https://learn.microsoft.com/example",
        }),
        finding("azure-lifecycle-retiring-skus", "fail", {
          resourceId: "b",
          retirementDate: "2026-12-02",
          source: "docs/azure/retiring-skus.json",
        }),
      ],
      "2026-10-15T12:00:00.000Z",
    ).rows;
    expect(linked?.source).toEqual({
      vendor: "Microsoft Azure",
      href: "https://learn.microsoft.com/example",
    });
    expect(bare?.source).toEqual({ vendor: "Microsoft Azure" });
  });
});
