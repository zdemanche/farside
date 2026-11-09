import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FARSIDE_IAC_HUB_PRODUCT } from "./products-entry.js";

const WORKFLOWS = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const HUB_INPUTS = ["customerName", "accountId", "run_identifier", "initialAdmins", "firstOwnerEmail", "adoptingProducts"];

describe("deploy skeleton is complete", () => {
  const stageWorkflows = FARSIDE_IAC_HUB_PRODUCT.stages.flatMap((stage) => [
    stage.workflow,
    ...("destroyWorkflow" in stage ? [stage.destroyWorkflow] : []),
  ]);

  it("has every stage workflow the PRODUCTS entry names", () => {
    for (const name of stageWorkflows) {
      expect(existsSync(join(WORKFLOWS, name)), name).toBe(true);
    }
  });

  it("keeps every deploy workflow dispatch-only and main-only", () => {
    for (const name of [...stageWorkflows, "deploy.yml", "deploy-customer.yml"]) {
      const text = readFileSync(join(WORKFLOWS, name), "utf8");
      expect(text, name).toMatch(/^on:\n {2}workflow_dispatch:/m);
      expect(text, name).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
      expect(text, name).toContain('if [ "$REF" != "refs/heads/main" ]');
    }
  });

  it("accepts the hub dispatch inputs on each up stage", () => {
    for (const stage of FARSIDE_IAC_HUB_PRODUCT.stages) {
      const text = readFileSync(join(WORKFLOWS, stage.workflow), "utf8");
      for (const input of HUB_INPUTS) {
        expect(text, `${stage.workflow} ${input}`).toMatch(new RegExp(`^ {6}${input}:$`, "m"));
      }
    }
  });
});

describe("iac-hub PRODUCTS proposal", () => {
  it("registers key farside with the Identity three-stage shape", () => {
    expect(FARSIDE_IAC_HUB_PRODUCT.key).toBe("Farside");
    expect(FARSIDE_IAC_HUB_PRODUCT.deploymentKey).toBe("farside");
    expect(FARSIDE_IAC_HUB_PRODUCT.stages.map((stage) => stage.key)).toEqual([
      "BackendArtifacts",
      "Infra",
      "Web",
    ]);
    expect(FARSIDE_IAC_HUB_PRODUCT.stages.every((stage) => stage.targetRepo === "moonaan-farside")).toBe(
      true,
    );
    expect(FARSIDE_IAC_HUB_PRODUCT.stages.every((stage) => stage.manifest === true)).toBe(true);
  });
});
