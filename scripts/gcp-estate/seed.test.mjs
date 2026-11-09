import { describe, expect, it, vi } from "vitest";
import {
  SKIPPED_NO_CREDENTIALS,
  buildSeedPlan,
  buildTeardownPlan,
  hasGcpCredentials,
  loadLiveSeed,
  loadManifest,
  renderStep,
  runSeed,
} from "./seed.mjs";

const CREDS = {
  HOME: "/home/x",
  FARSIDE_GCP_SEED_PROJECT: "farside-test",
  FARSIDE_GCP_BILLING_ACCOUNT: "000000-000000-000000",
};
const credsExist = (path) => path === "/home/x/.config/gcloud/application_default_credentials.json";

describe("gcp seed plan", () => {
  const plan = buildSeedPlan(loadManifest(), loadLiveSeed(), {
    project: "farside-test",
    billingAccount: "000000-000000-000000",
  });
  const ids = plan.map((entry) => entry.id);

  it("seeds every seedable ground-truth resource and the Recommender source VM", () => {
    const manifest = loadManifest();
    const seedable = manifest.items
      .filter((item) => item.type !== "recommender.googleapis.com/Recommendation")
      .map((item) => item.id)
      .filter((id) => id !== "gke-stale");
    for (const id of seedable) {
      expect(ids).toContain(id);
    }
    expect(ids).toContain("vm-parked");
    expect(plan.find((entry) => entry.id === "gke-stale")).toMatchObject({
      tool: "manual",
      phase: "skip",
    });
  });

  it("sets up the budget guard, services and billing export dataset first", () => {
    expect(ids.slice(0, 4)).toEqual([
      "enable-services",
      "budget-guard",
      "billing-export-dataset",
      "billing-export-enable",
    ]);
    expect(renderStep(plan[1])).toContain("--budget-amount=50USD");
    expect(renderStep(plan[1])).toContain("--filter-projects=projects/farside-test");
    expect(plan[3].note).toContain("no API");
  });

  it("creates the VM before attaching the in-use disk and binding the in-use address", () => {
    const vm = ids.indexOf("vm-harbor");
    expect(ids.indexOf("addr-bound")).toBeLessThan(vm);
    expect(ids.indexOf("disk-in-use-attach")).toBeGreaterThan(vm);
    expect(renderStep(plan[vm])).toContain("--address=addr-bound");
  });

  it("maps seeded properties onto flags", () => {
    const step = (id) => renderStep(plan.find((entry) => entry.id === id));
    expect(step("disk-parked")).not.toContain("--labels");
    expect(step("sql-zonal")).toContain("--availability-type=zonal");
    expect(step("sql-no-backup")).toContain("--no-backup");
    expect(step("sql-stale")).toContain("--database-version=MYSQL_5_6");
    expect(plan.find((entry) => entry.id === "sql-stale").optional).toBe(true);
    expect(step("cert-expiring-pem")).toContain("-days 30");
    expect(step("cert-current-pem")).toContain("-days 400");
  });

  it("splits phases so aged items can age before fresh ones are made", () => {
    const fresh = buildSeedPlan(loadManifest(), loadLiveSeed(), { phase: "fresh" }).map(
      (entry) => entry.id,
    );
    expect(fresh).toEqual(expect.arrayContaining(["snap-fresh", "image-current", "cert-expiring"]));
    expect(fresh).not.toContain("snap-aged");
    const base = buildSeedPlan(loadManifest(), loadLiveSeed(), { phase: "base" }).map(
      (entry) => entry.id,
    );
    expect(base).toEqual(expect.arrayContaining(["snap-aged", "image-stale", "disk-in-use"]));
    expect(base).not.toContain("snap-fresh");
  });

  it("tears down instances before their disks", () => {
    const teardown = buildTeardownPlan(loadManifest(), loadLiveSeed(), {
      project: "farside-test",
    }).map((entry) => entry.id);
    expect(teardown.indexOf("delete-vm-harbor")).toBeLessThan(
      teardown.indexOf("delete-disk-in-use"),
    );
    expect(teardown).toContain("delete-vm-parked");
    expect(teardown).not.toContain("delete-gke-stale");
  });
});

describe("gcp seed runner", () => {
  it("exits 0 and says skipped without GCP credentials, even with --apply", () => {
    const out = vi.fn();
    const exec = vi.fn();
    expect(
      runSeed({ argv: ["--apply"], env: { HOME: "/home/x" }, exists: () => false, exec, out }),
    ).toBe(0);
    expect(out).toHaveBeenCalledWith(SKIPPED_NO_CREDENTIALS);
    expect(exec).not.toHaveBeenCalled();
  });

  it("dry-runs by default when credentials exist", () => {
    const out = vi.fn();
    const exec = vi.fn();
    expect(runSeed({ argv: [], env: CREDS, exists: credsExist, exec, out })).toBe(0);
    expect(String(out.mock.calls[0][0])).toContain("dry run");
    expect(exec).not.toHaveBeenCalled();
  });

  it("applies only with --apply, a project and a billing account", () => {
    const exec = vi.fn();
    expect(
      runSeed({
        argv: ["--apply"],
        env: { HOME: "/home/x" },
        exists: credsExist,
        exec,
        out: vi.fn(),
      }),
    ).toBe(2);
    expect(exec).not.toHaveBeenCalled();
    expect(runSeed({ argv: ["--apply"], env: CREDS, exists: credsExist, exec, out: vi.fn() })).toBe(
      0,
    );
    const tools = new Set(exec.mock.calls.map((call) => call[0]));
    expect([...tools].sort()).toEqual(["bq", "gcloud", "openssl"]);
    const certArgs = exec.mock.calls.find((call) => call[1].includes("certificate-manager"))[1];
    expect(certArgs.some((arg) => arg.includes("{tmp}"))).toBe(false);
  });

  it("stops on a required failure but carries on past optional ones", () => {
    const out = vi.fn();
    const failOptional = vi.fn((_tool, args) => {
      if (args.includes("sql-stale")) {
        throw new Error("refused");
      }
    });
    expect(
      runSeed({ argv: ["--apply"], env: CREDS, exists: credsExist, exec: failOptional, out }),
    ).toBe(0);
    expect(out).toHaveBeenCalledWith("optional steps failed: sql-stale");
    const failRequired = vi.fn(() => {
      throw new Error("boom");
    });
    expect(
      runSeed({
        argv: ["--apply"],
        env: CREDS,
        exists: credsExist,
        exec: failRequired,
        out: vi.fn(),
      }),
    ).toBe(1);
    expect(failRequired).toHaveBeenCalledTimes(1);
  });

  it("detects credentials from ADC, GOOGLE_APPLICATION_CREDENTIALS or gcloud", () => {
    expect(hasGcpCredentials({ HOME: "/home/x" }, () => false)).toBe(false);
    expect(
      hasGcpCredentials(
        { GOOGLE_APPLICATION_CREDENTIALS: "/k.json" },
        (path) => path === "/k.json",
      ),
    ).toBe(true);
    expect(
      hasGcpCredentials({ CLOUDSDK_CONFIG: "/c" }, (path) => path === "/c/credentials.db"),
    ).toBe(true);
  });
});
