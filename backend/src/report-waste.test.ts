import { describe, expect, it } from "vitest";
import type { ExportIssueRow } from "./export.js";
import { sumIssueSavings, sumIssueSavingsByCurrency } from "./report.js";

function row(
  id: string,
  status: ExportIssueRow["status"],
  savings: ExportIssueRow["savings"],
): ExportIssueRow {
  return {
    id,
    checkId: "azure-waste-unattached-disks",
    resourceId: id,
    scopeId: "s",
    cloud: "azure",
    subscriptionOrProject: "s",
    status,
    coverage: "assessed",
    firstSeen: "2026-11-01T00:00:00.000Z",
    lastConfirmed: "2026-11-02T00:00:00.000Z",
    savings,
  } as ExportIssueRow;
}

const usd = (min: string, max: string) => ({ min, max, currency: "USD" });
const eur = (min: string, max: string) => ({ min, max, currency: "EUR" });

describe("report waste totals", () => {
  it("counts open issues only", () => {
    const rows = [
      row("a", "open", usd("10.00", "20.00")),
      row("b", "closed", usd("100.00", "200.00")),
      row("c", "not_confirmed", usd("1000.00", "2000.00")),
    ];
    expect(sumIssueSavings(rows)).toEqual({ min: "10.00", max: "20.00", currency: "USD" });
  });

  it("is null when every issue is closed", () => {
    expect(sumIssueSavings([row("a", "closed", usd("10.00", "20.00"))])).toBeNull();
    expect(sumIssueSavingsByCurrency([row("a", "closed", usd("10.00", "20.00"))])).toEqual([]);
  });

  it("never adds currencies together", () => {
    const rows = [row("a", "open", usd("10.00", "20.00")), row("b", "open", eur("5.00", "8.00"))];
    expect(sumIssueSavingsByCurrency(rows)).toEqual([
      { min: "10.00", max: "20.00", currency: "USD" },
      { min: "5.00", max: "8.00", currency: "EUR" },
    ]);
    expect(sumIssueSavings(rows)).toBeNull();
  });

  it("sums several open issues in one currency", () => {
    const rows = [row("a", "open", usd("10.00", "20.00")), row("b", "open", usd("1.50", "2.25"))];
    expect(sumIssueSavings(rows)).toEqual({ min: "11.50", max: "22.25", currency: "USD" });
  });

  it("skips open issues that have no savings", () => {
    expect(sumIssueSavings([row("a", "open", null)])).toBeNull();
  });
});
