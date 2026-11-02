import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RAW_PROVIDER_KEYS, scoreHealth, validateFinding } from "@farside/scan-contracts";
import { buildApp } from "./app.js";
import {
  UNATTACHED_DISKS,
  UnregisteredCheckError,
  acceptFinding,
  checkUnattachedDisks,
  runChecks,
} from "./checks.js";
import { toContractCoverage } from "./coverage.js";
import { factsFromManifest } from "./facts.js";
import { inventoryFromManifest, type GroundTruthManifest } from "./inventory.js";
import { DISK_SAVINGS_BASIS } from "./savings.js";
import { defaultHarvester } from "./scans.js";
import { ACTOR_HEADER, ORG_HEADER } from "./session.js";
import { MemoryStore } from "./store.js";

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/azure/ground-truth.json"), "utf8"),
) as GroundTruthManifest;

const inventory = inventoryFromManifest(MANIFEST);
const facts = factsFromManifest(MANIFEST);
const ORG = { [ORG_HEADER]: "org-a", [ACTOR_HEADER]: "actor-a" };

describe("check registry and rules", () => {
  it("refuses an unregistered check", () => {
    expect(() =>
      runChecks({ inventory, facts, checkIds: ["azure-waste-old-snapshots"] }),
    ).toThrow(UnregisteredCheckError);
  });

  it("rejects findings without evidence and undetermined without a closer", () => {
    expect(() =>
      acceptFinding({
        checkId: UNATTACHED_DISKS,
        result: "fail",
        evidence: { fields: {} },
        scope: { id: "main:check", cloud: "azure", subscriptionOrProject: "main" },
      }),
    ).toThrow(/evidence/);
    expect(() =>
      acceptFinding({
        checkId: UNATTACHED_DISKS,
        result: "undetermined",
        evidence: { fields: { diskId: "x" } },
        scope: { id: "main:check", cloud: "azure", subscriptionOrProject: "main" },
      }),
    ).toThrow(/closer/);
  });

  it("marks unread subscriptions unassessed and leaves them out of the score", () => {
    const { findings, coverage } = runChecks({
      inventory,
      facts,
      checkIds: [UNATTACHED_DISKS],
      unreadSubscriptions: ["ghost"],
    });
    const health = scoreHealth(toContractCoverage(coverage), findings);
    const withoutGhost = runChecks({ inventory, facts, checkIds: [UNATTACHED_DISKS] });
    expect(scoreHealth(toContractCoverage(withoutGhost.coverage), withoutGhost.findings).score).toBe(
      health.score,
    );
    expect(coverage.some((entry) => entry.subscriptionOrProject === "ghost" && entry.state === "unassessed")).toBe(
      true,
    );
  });
});

describe("unattached disk check", () => {
  it("fails the seeded unattached disk and passes the attached lookalike", () => {
    const findings = checkUnattachedDisks(inventory, facts);
    const fail = findings.find((finding) => finding.result === "fail");
    const pass = findings.find((finding) => finding.result === "pass");
    expect(fail?.evidence.fields.diskId).toBe("disk-unattached");
    expect(fail?.evidence.fields.diskState).toBe("Unattached");
    expect(fail?.savings).toEqual({ min: "8.00", max: "12.00", currency: "USD" });
    expect(fail?.evidence.fields.savingsBasis).toBe(DISK_SAVINGS_BASIS);
    expect(pass?.evidence.fields.diskId).toBe("disk-attached");
    expect(pass?.result).toBe("pass");
    expect(validateFinding(fail!)).toEqual([]);
    for (const key of RAW_PROVIDER_KEYS) {
      expect(JSON.stringify(findings)).not.toContain(key);
    }
  });

  it("returns undetermined when diskState is missing", () => {
    const findings = checkUnattachedDisks(inventory, [
      {
        resourceUri: inventory.resources.find((row) => row.displayName.includes("Unattached"))!.resourceUri,
        fields: { diskId: "disk-unattached", location: "eastus" },
      },
    ]);
    expect(findings[0]?.result).toBe("undetermined");
    expect(findings[0]?.closer).toMatch(/diskState/);
  });
});

describe("unattached disk harvest to API", () => {
  const store = new MemoryStore();
  const app = buildApp(store, { harvester: defaultHarvester() });

  afterAll(async () => {
    await app.close();
  });

  it("stores the finding from a scan and returns it with evidence", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/v1/orgs/org-a/connections",
      headers: ORG,
      payload: { tenantId: "tenant-1", subscriptionId: "main" },
    });
    expect(created.statusCode).toBe(201);
    let findings: Array<{ result: string; evidence: { fields: Record<string, unknown> } }> = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/orgs/org-a/findings",
        headers: ORG,
      });
      findings = response.json().findings;
      if (findings.some((finding) => finding.result === "fail")) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const fail = findings.find((finding) => finding.evidence.fields.diskId === "disk-unattached");
    expect(fail?.result).toBe("fail");
    expect(fail?.evidence.fields.diskState).toBe("Unattached");
    expect(JSON.stringify(fail)).not.toMatch(/armBody|sdkResponse|"payload"/);
  });
});
