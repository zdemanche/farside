import { render } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { expect } from "vitest";
import { DataProvider } from "./data/context";
import { demoSource } from "./data/demo";
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
