import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { CONNECT_STEPS, REQUIRED_AZURE_ROLES } from "./connect";

describe("Connect screen", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.title = "Farside";
    window.location.hash = "#connect";
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("lists required roles and steps and collects tenant and subscription ids", async () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Connect Azure" })).toBeTruthy();
    for (const role of REQUIRED_AZURE_ROLES) {
      expect(screen.getByText(role)).toBeTruthy();
    }
    for (const step of CONNECT_STEPS) {
      expect(screen.getByText(step)).toBeTruthy();
    }
    expect(document.querySelector("input[type='password']")).toBeNull();
    expect(document.querySelector("input[name='clientSecret']")).toBeNull();
    expect(screen.queryByLabelText(/secret/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("Azure tenant id"), {
      target: { value: "tenant-1" },
    });
    fireEvent.change(screen.getByLabelText("Azure subscription id"), {
      target: { value: "sub-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect subscription" }));
    expect(
      screen.getByRole("status").textContent,
    ).toContain("tenant-1");
    expect(screen.getByRole("status").textContent).toContain("sub-1");
  });

  it("has no axe violations on the Connect screen", async () => {
    const { container } = render(<App />);
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
