import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { CONNECT_STEPS, REQUIRED_AZURE_ROLES } from "./connect-data";
import { DataError } from "./data/error";
import { expectAxeClean, sourceWith } from "./test-utils";

const TENANT = "11111111-2222-3333-4444-555555555555";
const SUBSCRIPTION = "66666666-7777-8888-9999-000000000000";

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Azure tenant id"), {
    target: { value: TENANT },
  });
  fireEvent.change(screen.getByLabelText("Azure subscription id"), {
    target: { value: SUBSCRIPTION },
  });
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
    const connect = vi
      .fn()
      .mockResolvedValue({ scanStarted: true, attention: null });
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
    await waitFor(() =>
      expect(
        within(screen.getByRole("main")).getByRole("status").textContent,
      ).toContain("First scan started"),
    );
    expect(connect.mock.calls[0]?.[0]).toEqual({
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION,
    });
    expect(
      within(screen.getByRole("main")).getByRole("status").textContent,
    ).toContain(TENANT);
    expect(
      within(screen.getByRole("main")).getByRole("status").textContent,
    ).toContain(SUBSCRIPTION);
  });

  it("does not claim a scan started when the source says none did", async () => {
    render(<App demo />);
    await screen.findByLabelText("Azure tenant id");
    fillAndSubmit();
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .map((node) => node.textContent)
          .join(" "),
      ).toContain("Demo mode: nothing was connected"),
    );
    expect(document.body.textContent).not.toContain("First scan started");
  });

  it("reports a failed connect as an alert and not as success", async () => {
    const connect = vi
      .fn()
      .mockRejectedValue(new DataError("failed", 502, "502 Bad Gateway"));
    render(<App source={sourceWith({ connect })} />);
    fillAndSubmit();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /502 Bad Gateway/,
    );
    expect(document.body.textContent).not.toContain("First scan started");
  });

  it("has no axe violations on the Connect screen", async () => {
    const { container } = render(<App demo />);
    await screen.findByLabelText("Azure tenant id");
    await expectAxeClean(container);
  });

  it("shows only the attention text when no scan started because scans are paused", async () => {
    const connect = vi
      .fn()
      .mockResolvedValue({ scanStarted: false, attention: "scans paused" });
    render(<App source={sourceWith({ connect })} />);
    fillAndSubmit();
    await waitFor(() =>
      expect(
        within(screen.getByRole("main")).getByRole("status").textContent,
      ).toContain("scans paused"),
    );
  });

  it("links to Scans after a successful connect", async () => {
    const connect = vi
      .fn()
      .mockResolvedValue({ scanStarted: true, attention: null });
    render(<App source={sourceWith({ connect })} />);
    fillAndSubmit();
    const link = await screen.findByRole("link", { name: "View scans" });
    expect(link.getAttribute("href")).toBe("#scans");
  });

  it("rejects ids that are not GUIDs with inline errors and sends nothing", async () => {
    const connect = vi.fn();
    render(<App source={sourceWith({ connect })} />);
    fireEvent.change(screen.getByLabelText("Azure tenant id"), {
      target: { value: "tenant-1" },
    });
    fireEvent.change(screen.getByLabelText("Azure subscription id"), {
      target: { value: SUBSCRIPTION },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Connect subscription" }),
    );
    const tenant = screen.getByLabelText("Azure tenant id");
    expect(tenant.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/Enter a GUID/).id).toBe(
      tenant.getAttribute("aria-describedby"),
    );
    expect(
      screen
        .getByLabelText("Azure subscription id")
        .hasAttribute("aria-invalid"),
    ).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("First scan started");
  });

  it("shows a pending button while the connect is in flight", async () => {
    let finish: (value: {
      scanStarted: boolean;
      attention: null;
    }) => void = () => {};
    const connect = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<App source={sourceWith({ connect: connect as never })} />);
    fillAndSubmit();
    const pending = await screen.findByRole("button", {
      name: "Connecting...",
    });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).not.toContain("Connected tenant");
    finish({ scanStarted: false, attention: null });
    await screen.findByRole("button", { name: "Connect subscription" });
  });
});
