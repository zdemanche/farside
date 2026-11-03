import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings, THEME_STORAGE_KEY } from "./Settings";

describe("Settings appearance", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", "moonaan");
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("has no axe violations", async () => {
    const { container } = render(<Settings />);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it("starts from the theme the guard set on the document", () => {
    document.documentElement.setAttribute("data-theme", "daylight");
    render(<Settings />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Daylight" }).checked).toBe(true);
  });

  it("switches the document theme and stores the choice under the shared key", () => {
    render(<Settings />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Moonaan dark" }).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Daylight" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("daylight");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("daylight");
    fireEvent.click(screen.getByRole("radio", { name: "Moonaan dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("moonaan");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("moonaan");
  });

  it("still switches the theme when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Settings />);
    fireEvent.click(screen.getByRole("radio", { name: "Daylight" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("daylight");
  });
});
