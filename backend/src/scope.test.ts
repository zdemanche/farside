import { describe, expect, it } from "vitest";
import { scopeOf, subscriptionOf } from "./scope.js";
import { projectOf } from "./gcp-inventory.js";

const AZURE_DISK =
  "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/disk-unattached";
const GCP_DISK = "//compute.googleapis.com/projects/p1/zones/us-central1-a/disks/parked";

describe("scopeOf", () => {
  it("keeps Azure ARM subscriptions on index 2 and GCP projects on the projects segment", () => {
    expect(subscriptionOf(AZURE_DISK)).toBe("main");
    expect(scopeOf("azure", AZURE_DISK)).toBe("main");
    expect(scopeOf("gcp", GCP_DISK)).toBe("p1");
    expect(scopeOf("gcp", GCP_DISK)).toBe(projectOf(GCP_DISK));
    expect(scopeOf("azure", GCP_DISK)).toBe("compute.googleapis.com");
  });
});
