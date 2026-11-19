import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateInventory } from "./validate.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

type Inv = { resources: Array<{ tags: Record<string, unknown> }> };

function inventory(): Inv {
  return JSON.parse(readFileSync(join(fixtures, "inventory.valid.json"), "utf8")) as Inv;
}

describe("customer-chosen tag keys are not raw provider payloads", () => {
  it("accepts a resource tagged raw or payload", () => {
    const value = inventory();
    value.resources[0]!.tags = { raw: "true", payload: "x", owner: "team-a" };
    expect(validateInventory(value)).toEqual([]);
  });

  it("still rejects a raw payload key outside the tags", () => {
    const value = inventory() as unknown as { resources: Array<Record<string, unknown>> };
    value.resources[0]!.raw = { anything: 1 };
    const errors = validateInventory(value);
    expect(errors.some((error) => error.message.includes("raw provider payload"))).toBe(true);
  });

  it("still rejects a raw payload object nested inside a tag value", () => {
    const value = inventory();
    value.resources[0]!.tags = { owner: { raw: { sdk: true } } };
    const errors = validateInventory(value);
    expect(errors.some((error) => error.message.includes("raw provider payload"))).toBe(true);
  });
});
