import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { EMPTY_STATE, PRODUCT_NAME, SHELL_NAV } from "./shell";

describe("console shell", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the product name and empty state", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: PRODUCT_NAME })).toBeTruthy();
    expect(screen.getByText(EMPTY_STATE)).toBeTruthy();
  });

  it("lists every planned destination", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: PRODUCT_NAME });
    for (const item of SHELL_NAV) {
      expect(nav.textContent).toContain(item);
    }
  });
});
