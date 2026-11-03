import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as lib from "./lib.js";

const ENTRY = fileURLToPath(new URL("./lib.ts", import.meta.url));
const FORBIDDEN = /^(fastify|@aws-sdk\/)/;
const SPEC =
  /(?:import|export)(?:\s+type)?(?:[\s\S]*?\sfrom\s*|\s+)["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function walk(entry: string): { files: string[]; hits: string[] } {
  const files = new Set<string>();
  const hits: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPEC)) {
      const spec = match[1] ?? match[2];
      if (!spec) {
        continue;
      }
      if (FORBIDDEN.test(spec)) {
        hits.push(`${spec} from ${file}`);
        continue;
      }
      if (!spec.startsWith(".") || spec.endsWith(".json")) {
        continue;
      }
      queue.push(join(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return { files: [...files], hits };
}

describe("library entry", () => {
  it("exports the provider registry, checks and scan core", () => {
    expect(lib.allProviders().map((provider) => provider.cloud).sort()).toEqual(["azure", "gcp"]);
    expect(lib.registeredCheckIds("azure")).toEqual(lib.providerFor("azure").checks.map((check) => check.checkId));
    expect(lib.registeredCheckIds("gcp")).toEqual(lib.providerFor("gcp").checks.map((check) => check.checkId));
    expect(lib.runChecks).toEqual(expect.any(Function));
    expect(lib.ScanRunner).toEqual(expect.any(Function));
    expect(lib.defaultHarvester).toEqual(expect.any(Function));
  });

  it("does not import Fastify or the AWS SDK", () => {
    const { files, hits } = walk(ENTRY);
    expect(files).toContain(ENTRY);
    expect(files.some((file) => file.endsWith("observability.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("app.ts"))).toBe(false);
    expect(files.some((file) => file.endsWith("dynamo-store.ts"))).toBe(false);
    expect(hits).toEqual([]);
  });
});
