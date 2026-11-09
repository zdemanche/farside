import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Sign-in and org claim (#46 / #49) on a build with VITE_FARSIDE_IDENTITY_* set. The OIDC
 * provider and the Farside API are stubbed with page.route on the console's own origin;
 * no real Identity tenant is involved (that is the #51 rehearsal).
 */

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

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
  sub: "user-1",
  org: "org-a",
  email: "cto@example.test",
  exp: 4_000_000_000,
})}.c2ln`;

type Claim = { claimed: boolean; member: boolean; memberCount: number };

async function stub(
  page: Page,
  initial: Claim = { claimed: false, member: false, memberCount: 0 },
) {
  const state = { ...initial };
  const apiRequests: Request[] = [];
  await page.route("**/idp/.well-known/openid-configuration", (route) =>
    route.fulfill({
      json: {
        authorization_endpoint: new URL("/idp/authorize", route.request().url()).toString(),
        token_endpoint: new URL("/idp/token", route.request().url()).toString(),
      },
    }),
  );
  await page.route(
    (url) => url.pathname === "/idp/authorize",
    (route) => {
      const url = new URL(route.request().url());
      const back = new URL(url.searchParams.get("redirect_uri") ?? "/", url);
      back.searchParams.set("code", "e2e-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return route.fulfill({ status: 302, headers: { location: back.toString() } });
    },
  );
  await page.route("**/idp/token", (route) =>
    route.fulfill({ json: { access_token: TOKEN, token_type: "Bearer", expires_in: 300 } }),
  );
  await page.route("**/api/v1/orgs/**", (route) => {
    const request = route.request();
    apiRequests.push(request);
    const path = new URL(request.url()).pathname.replace("/api/v1/orgs/org-a", "");
    if (path === "/claim") {
      const outcome = request.method() === "POST" ? (state.claimed ? "joined" : "claimed") : null;
      if (outcome) {
        state.memberCount += 1;
        state.claimed = true;
        state.member = true;
      }
      return route.fulfill({
        status: outcome === "claimed" ? 201 : 200,
        json: {
          ...(outcome ? { outcome } : {}),
          orgId: "org-a",
          claimedAt: state.claimed ? "2026-11-09T00:00:00.000Z" : null,
          role: state.member ? (outcome === "joined" ? "member" : "owner") : null,
          owner: outcome === "claimed",
          ...state,
        },
      });
    }
    if (path === "/estate") {
      return route.fulfill({
        json: {
          empty: true,
          resourceTotal: 0,
          noOwnerTotal: 0,
          coverage: { assessed: 0, unassessed: 0, undetermined: 0 },
          healthScore: null,
        },
      });
    }
    if (path === "/scans") {
      return route.fulfill({ json: { scans: [] } });
    }
    return route.fulfill({ status: 404, json: { title: "Not found" } });
  });
  return { apiRequests };
}

async function signedIn(page: Page) {
  await page.addInitScript((token) => {
    sessionStorage.setItem(
      "farside.identity.session",
      JSON.stringify({ token, expiresAt: null, orgId: "org-a", name: "cto@example.test" }),
    );
  }, TOKEN);
}

async function violationsOf(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }));
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const theme of THEMES) {
  test(`sign-in has no accessibility violations in the ${theme} theme`, async ({ page }) => {
    await stub(page);
    await page.addInitScript((value) => localStorage.setItem("reflow-theme", value), theme);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(page).toHaveTitle("Sign in - Farside");
    await expect(page.getByRole("navigation", { name: "Farside" })).toHaveCount(0);
    expect(await violationsOf(page)).toEqual([]);
    await noSidewaysScroll(page);
  });

  for (const [name, initial] of [
    ["Claim your organisation", { claimed: false, member: false, memberCount: 0 }],
    ["Join your organisation", { claimed: true, member: false, memberCount: 2 }],
  ] as const) {
    test(`"${name}" has no accessibility violations in the ${theme} theme`, async ({ page }) => {
      await stub(page, initial);
      await signedIn(page);
      await page.addInitScript((value) => localStorage.setItem("reflow-theme", value), theme);
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      await expect(page).toHaveTitle(`${name} - Farside`);
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      expect(await violationsOf(page)).toEqual([]);
      await noSidewaysScroll(page);
    });
  }
}

test("on the sign-in screen the skip link is the first tab stop, then the sign-in button", async ({
  page,
}) => {
  await stub(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in with Moonaan Identity" })).toBeFocused();
});

test("signs in with PKCE, claims the org, then uses the console with a bearer token", async ({
  page,
}) => {
  const { apiRequests } = await stub(page);
  const authorize = page.waitForRequest((request) => request.url().includes("/idp/authorize"));
  const token = page.waitForRequest("**/idp/token");
  await page.goto("/#issues");
  await page.getByRole("button", { name: "Sign in with Moonaan Identity" }).click();

  const params = new URL((await authorize).url()).searchParams;
  expect(params.get("response_type")).toBe("code");
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const exchange = new URLSearchParams((await token).postData() ?? "");
  expect(exchange.get("grant_type")).toBe("authorization_code");
  expect(exchange.get("code")).toBe("e2e-code");
  expect(exchange.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);

  await expect(
    page.getByRole("heading", { level: 1, name: "Claim your organisation" }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/code=/);
  await page.getByRole("button", { name: "Claim organisation" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Issues" })).toBeFocused();
  const nav = page.getByRole("navigation", { name: "Farside" });
  for (const name of NAV_ITEMS) {
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await nav.getByRole("link", { name: "Estate", exact: true }).click();
  await expect(page).toHaveTitle("Estate - Farside");

  expect(apiRequests.length).toBeGreaterThan(2);
  for (const request of apiRequests) {
    const headers = await request.allHeaders();
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["x-farside-org"]).toBeUndefined();
  }
  expect(await page.evaluate(() => Object.keys(localStorage))).not.toContain(
    "farside.identity.session",
  );

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeFocused();
  expect(await page.evaluate(() => sessionStorage.getItem("farside.identity.session"))).toBeNull();
});
