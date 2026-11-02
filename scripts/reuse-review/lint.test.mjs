import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_GCP_LAUNCH_CHECK_IDS,
  lintReuseMap,
  lintReuseMapFile,
} from "./lint.mjs";
import { REQUIRED_LAUNCH_CHECK_IDS } from "../azure-spec/lint.mjs";

function mappedCheck(id, cloud = "azure", overrides = {}) {
  return {
    id,
    cloud,
    title: id,
    atlas: {
      kind: "method",
      id: "discover-harvest",
      title: "pattern",
      relation: "follows",
    },
    costReporter: null,
    ...overrides,
  };
}

function validMap(overrides = {}) {
  return {
    version: 1,
    checks: [
      ...REQUIRED_LAUNCH_CHECK_IDS.map((id) => mappedCheck(id, "azure")),
      ...REQUIRED_GCP_LAUNCH_CHECK_IDS.map((id) => mappedCheck(id, "gcp")),
    ],
    ...overrides,
  };
}

describe("reuse atlas-check map lint", () => {
  it("accepts the committed map against the Azure spec", () => {
    expect(lintReuseMapFile()).toEqual([]);
  });

  it("fails when an Azure launch check is missing", () => {
    const map = validMap();
    map.checks = map.checks.filter((check) => check.id !== REQUIRED_LAUNCH_CHECK_IDS[0]);
    expect(
      lintReuseMap(map, REQUIRED_LAUNCH_CHECK_IDS).some((error) =>
        error.includes(REQUIRED_LAUNCH_CHECK_IDS[0]),
      ),
    ).toBe(true);
  });

  it("fails when a GCP launch check is missing", () => {
    const map = validMap();
    map.checks = map.checks.filter((check) => check.id !== REQUIRED_GCP_LAUNCH_CHECK_IDS[0]);
    expect(
      lintReuseMap(map, REQUIRED_LAUNCH_CHECK_IDS).some((error) =>
        error.includes(REQUIRED_GCP_LAUNCH_CHECK_IDS[0]),
      ),
    ).toBe(true);
  });

  it("fails when atlas.relation is follows without an id", () => {
    const map = validMap();
    map.checks[0].atlas.id = null;
    expect(
      lintReuseMap(map, REQUIRED_LAUNCH_CHECK_IDS).some((error) =>
        error.includes("atlas.id is required"),
      ),
    ).toBe(true);
  });

  it("fails a map file that drops atlas", () => {
    const map = validMap();
    delete map.checks[1].atlas;
    const dir = mkdtempSync(join(tmpdir(), "reuse-map-"));
    const mapPath = join(dir, "map.json");
    const specPath = join(dir, "spec.json");
    writeFileSync(mapPath, JSON.stringify(map));
    writeFileSync(
      specPath,
      JSON.stringify({ checks: REQUIRED_LAUNCH_CHECK_IDS.map((id) => ({ id })) }),
    );
    expect(lintReuseMapFile(mapPath, specPath).some((error) => error.includes("atlas"))).toBe(
      true,
    );
  });
});
