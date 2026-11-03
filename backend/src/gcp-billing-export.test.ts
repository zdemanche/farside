import { describe, expect, it } from "vitest";
import {
  BILLING_EXPORT_DATASET_CLOSER,
  BILLING_EXPORT_EMPTY_CLOSER,
  BILLING_EXPORT_ROLE,
  BILLING_EXPORT_STEPS,
  detectBillingExport,
} from "./gcp-billing-export.js";

describe("gcp billing export onboarding", () => {
  it("marks cost not connected and lists enablement steps when the dataset is absent", () => {
    const onboarding = detectBillingExport({ state: "absent" });
    expect(onboarding.costConnected).toBe(false);
    expect(onboarding.state).toBe("absent");
    expect(onboarding.steps).toEqual(BILLING_EXPORT_STEPS);
    expect(onboarding.closer).toBe(BILLING_EXPORT_DATASET_CLOSER);
    expect(onboarding.historyDays).toBeUndefined();
    expect(onboarding.startDate).toBeUndefined();
  });

  it("names missing BigQuery access when the dataset is not readable", () => {
    const onboarding = detectBillingExport({ state: "unreadable" });
    expect(onboarding.costConnected).toBe(false);
    expect(onboarding.missingRole).toBe(BILLING_EXPORT_ROLE);
    expect(onboarding.closer).toBe(BILLING_EXPORT_DATASET_CLOSER);
    expect(onboarding.steps).toContain("Grant the Farside workload BigQuery access to the billing export dataset.");
  });

  it("shows the start date and zero history on an empty first day", () => {
    const onboarding = detectBillingExport({ state: "empty", enabledOn: "2026-11-03" });
    expect(onboarding.costConnected).toBe(true);
    expect(onboarding.fillsForward).toBe(true);
    expect(onboarding.startDate).toBe("2026-11-03");
    expect(onboarding.historyDays).toBe(0);
    expect(onboarding.closer).toBe(BILLING_EXPORT_EMPTY_CLOSER);
    expect(onboarding.steps).toEqual([]);
    expect(JSON.stringify(onboarding)).not.toMatch(/estimate/i);
  });

  it("counts completed export days once rows are readable", () => {
    const onboarding = detectBillingExport({
      state: "readable",
      enabledOn: "2026-10-20",
      completedDays: ["2026-10-20", "2026-10-21", "2026-10-22"],
    });
    expect(onboarding.costConnected).toBe(true);
    expect(onboarding.steps).toEqual([]);
    expect(onboarding.startDate).toBe("2026-10-20");
    expect(onboarding.historyDays).toBe(3);
    expect(onboarding.closer).toBeUndefined();
  });
});
