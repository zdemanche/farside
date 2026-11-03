import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_AUTHOR,
  PLUGIN_LICENSE,
  PLUGIN_NAME,
  lintFindingsMethodSkill,
  lintPluginCommands,
  lintPluginManifest,
  lintPluginManifestFile,
} from "./lint.mjs";

function validManifest(overrides = {}) {
  return {
    name: PLUGIN_NAME,
    version: "0.1.0",
    author: { name: PLUGIN_AUTHOR },
    license: PLUGIN_LICENSE,
    skills: ["./skills"],
    commands: ["./commands"],
    ...overrides,
  };
}

describe("plugin manifest lint", () => {
  it("accepts the committed plugin.json against the product version", () => {
    expect(lintPluginManifestFile()).toEqual([]);
  });

  it("fails when the name is not farside", () => {
    expect(lintPluginManifest(validManifest({ name: "other" }), "0.1.0").some((error) => error.includes("name"))).toBe(
      true,
    );
  });

  it("fails when the author is not Moonaan, LLC", () => {
    expect(
      lintPluginManifest(validManifest({ author: { name: "Other" } }), "0.1.0").some((error) =>
        error.includes("author.name"),
      ),
    ).toBe(true);
  });

  it("fails when the licence is not proprietary UNLICENSED", () => {
    expect(lintPluginManifest(validManifest({ license: "MIT" }), "0.1.0").some((error) => error.includes("license"))).toBe(
      true,
    );
  });

  it("fails when the version drifts from the product", () => {
    expect(
      lintPluginManifest(validManifest({ version: "9.9.9" }), "0.1.0").some((error) => error.includes("product version")),
    ).toBe(true);
  });

  it("fails a file whose version does not match package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-lint-"));
    const manifestPath = join(dir, "plugin.json");
    const packagePath = join(dir, "package.json");
    writeFileSync(manifestPath, JSON.stringify(validManifest({ version: "0.1.0" })));
    writeFileSync(packagePath, JSON.stringify({ version: "0.2.0" }));
    expect(lintPluginManifestFile(manifestPath, packagePath).some((error) => error.includes("0.2.0"))).toBe(true);
  });

  it("fails when the findings-method skill drops a required phrase", () => {
    expect(lintFindingsMethodSkill("# empty").some((error) => error.includes("issue id"))).toBe(true);
  });

  it("accepts connect, scan and findings command wrappers", () => {
    expect(lintPluginCommands()).toEqual([]);
  });
});
