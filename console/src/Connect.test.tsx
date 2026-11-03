import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { CONNECT_STEPS, REQUIRED_AZURE_ROLES } from "./connect-data";
import { DataError } from "./data/error";
import { expectAxeClean, sourceWith } from "./test-utils";

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Azure tenant id"), { target: { value: "tenant-1" } });
  fireEvent.change(screen.getByLabelText("Azure subscription id"), { target: { value: "sub-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect subscription" }));
}

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

  it("lists required roles and steps and sends tenant and subscription ids to the source", async () => {
    const connect = vi.fn().mockResolvedValue({ scanStarted: true, attention: null });
    render(<App source={sourceWith({ connect })} />);
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

    fillAndSubmit();
    await waitFor(() => expect(within(screen.getByRole("main")).getByRole("status").textContent).toContain("First scan started"));
    expect(connect.mock.calls[0]?.[0]).toEqual({ tenantId: "tenant-1", subscriptionId: "sub-1" });
    expect(within(screen.getByRole("main")).getByRole("status").textContent).toContain("tenant-1");
    expect(within(screen.getByRole("main")).getByRole("status").textContent).toContain("sub-1");
  });

  it("does not claim a scan started when the source says none did", async () => {
    render(<App demo />);
    fillAndSubmit();
    await waitFor(() =>
      expect(screen.getAllByRole("status").map((node) => node.textContent).join(" ")).toContain(
        "Demo mode: nothing was connected",
      ),
    );
    expect(document.body.textContent).not.toContain("First scan started");
  });

  it("reports a failed connect as an alert and not as success", async () => {
    const connect = vi.fn().mockRejectedValue(new DataError("failed", 502, "502 Bad Gateway"));
    render(<App source={sourceWith({ connect })} />);
    fillAndSubmit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/502 Bad Gateway/);
    expect(document.body.textContent).not.toContain("First scan started");
  });

  it("has no axe violations on the Connect screen", async () => {
    const { container } = render(<App demo />);
    await expectAxeClean(container);
  });
});
