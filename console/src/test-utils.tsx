import { render } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { expect } from "vitest";
import { DataProvider } from "./data/context";
import { demoSource } from "./data/demo";
import type { KeyValueStore } from "./data/identity";
import type { DataSource } from "./data/types";

export async function expectAxeClean(container: HTMLElement) {
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(results.violations).toEqual([]);
}

export function sourceWith(overrides: Partial<DataSource>): DataSource {
  return { ...demoSource(), ...overrides };
}

export function renderScreen(ui: ReactNode, source: DataSource = demoSource()) {
  return render(<DataProvider source={source}>{ui}</DataProvider>);
}

export function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
  };
}

/** An unsigned JWT-shaped token; the console only reads claims, the API verifies. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.c2ln`;
}
