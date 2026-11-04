import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const DEMO_DISK =
  "/subscriptions/main/resourceGroups/farside-seed/providers/Microsoft.Compute/disks/disk-unattached";

const ROUTES = [
  "estate",
  "connect",
  "scans",
  "settings",
  "inventory",
  "issues",
  "cost-and-waste",
  "lifecycle",
  "recovery",
  "blind-spots",
  "billing",
  "offboarding",
  "scans/scan-1",
  "issues/disk-unattached",
  `inventory?resource=${encodeURIComponent(DEMO_DISK)}`,
] as const;

const THEMES = ["moonaan", "daylight"] as const;

const NAV_ITEMS = [
  "Estate",
  "Connect",
  "Scans",
  "Settings",
  "Inventory",
  "Issues",
  "Cost and waste",
  "Lifecycle",
  "Recovery",
  "Blind spots",
  "Billing",
  "Offboarding",
] as const;

async function open(page: Page, route: string) {
  await page.goto(`/#${route}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

async function violationsOf(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }));
}

for (const route of ROUTES) {
  test.describe(`#${route}`, () => {
    for (const theme of THEMES) {
      test(`has no accessibility violations in the ${theme} theme, contrast included`, async ({
        page,
      }) => {
        await page.addInitScript((value) => localStorage.setItem("reflow-theme", value), theme);
        await open(page, route);
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
        expect(await violationsOf(page)).toEqual([]);
      });
    }

    test("does not scroll the page sideways", async ({ page }) => {
      await open(page, route);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test("the skip link is the first tab stop and moves focus to the main region", async ({ page }) => {
  await open(page, "estate");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
});

test("the navigation is reachable and operable from the keyboard", async ({ page }) => {
  await open(page, "estate");
  const nav = page.getByRole("navigation", { name: "Farside" });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Cloud")).toBeFocused();
  for (const name of NAV_ITEMS) {
    await page.keyboard.press("Tab");
    await expect(nav.getByRole("link", { name, exact: true })).toBeFocused();
  }
  await nav.getByRole("link", { name: "Scans", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#scans$/);
  await expect(page.getByRole("heading", { level: 1, name: "Scans" })).toBeFocused();
});

test("each navigation link sets the document title and focuses the page heading", async ({
  page,
}) => {
  await open(page, "estate");
  const nav = page.getByRole("navigation", { name: "Farside" });
  for (const name of NAV_ITEMS.filter((item) => item !== "Estate")) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveTitle(`${name} - Farside`);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  }
});

test("an unknown hash shows the not-found page with a title and a way back", async ({ page }) => {
  await page.goto("/#nope");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page).toHaveTitle("Page not found - Farside");
  expect(await violationsOf(page)).toEqual([]);
});
