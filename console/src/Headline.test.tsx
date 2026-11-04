import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoSource } from "./data/demo";
import { DataError } from "./data/error";
import { Headline } from "./Headline";
import { expectAxeClean, renderScreen, sourceWith } from "./test-utils";

describe("Headline", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  afterEach(() => {
    cleanup();
  });

  it("shows each figure with a link to the page that supports it", async () => {
    const { container } = renderScreen(<Headline />);
    await waitFor(() => expect(screen.getByRole("link", { name: "Monthly cost" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "Monthly cost" }).getAttribute("href")).toBe(
      "#cost-and-waste",
    );
    expect(screen.getByRole("link", { name: "Nameable waste" }).getAttribute("href")).toBe(
      "#issues",
    );
    expect(screen.getByText(/USD\s2,252\.50 a month/)).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByText("2 scopes")).toBeTruthy();
    await expectAxeClean(container);
  });

  it("says not assessed and shows no number when the checks were not assessed", async () => {
    renderScreen(<Headline />);
    const link = await screen.findByRole("link", { name: "Things losing support in 90 days" });
    expect(link.nextElementSibling?.textContent).toBe("not assessed");
  });

  it("labels a check with no live run as not supported and shows no number", async () => {
    const base = await demoSource().headline();
    renderScreen(
      <Headline />,
      sourceWith({
        headline: async () => ({
          ...base,
          figures: base.figures.map((figure) =>
            figure.id === "waste" ? { ...figure, status: "not_supported", value: null } : figure,
          ),
        }),
      }),
    );
    const link = await screen.findByRole("link", { name: "Nameable waste" });
    expect(link.parentElement?.textContent).toMatch(/not supported$/);
  });

  it("shows per-cloud values instead of one summed figure", async () => {
    const base = await demoSource().headline();
    renderScreen(
      <Headline />,
      sourceWith({
        headline: async () => ({
          ...base,
          figures: [
            {
              id: "monthlyCost",
              label: "Monthly cost",
              href: "#cost-and-waste",
              status: "ok",
              value: {
                mixedCurrencies: true,
                byCloud: {
                  azure: { amount: "100.00", currency: "USD" },
                  gcp: { amount: "80.00", currency: "EUR" },
                },
              },
            },
          ],
        }),
      }),
    );
    expect(
      await screen.findByText(/azure: USD\s100\.00 a month; gcp: EUR\s80\.00 a month/),
    ).toBeTruthy();
  });

  it("says the headline failed instead of showing figures", async () => {
    renderScreen(
      <Headline />,
      sourceWith({
        headline: async () => {
          throw new DataError("failed", 500, "boom");
        },
      }),
    );
    expect(await screen.findByText(/headline could not be loaded/)).toBeTruthy();
  });
});
