import { defineConfig, devices } from "@playwright/test";

const PORT = 4180;
/** A second build with sign-in configured; the provider and API are stubbed per test on this origin. */
const IDENTITY_PORT = 4181;
const CI = Boolean(process.env.CI);

const IDENTITY_ENV = [
  `VITE_FARSIDE_API_URL=http://localhost:${IDENTITY_PORT}/api`,
  `VITE_FARSIDE_IDENTITY_ISSUER=http://localhost:${IDENTITY_PORT}/idp`,
  "VITE_FARSIDE_IDENTITY_CLIENT_ID=farside-console",
  "VITE_FARSIDE_IDENTITY_ORG_CLAIM=org",
].join(" ");

const PHONE = { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } };
const DESKTOP = { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } };
const IDENTITY_SPEC = /identity\.spec\.ts$/;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI
    ? [["list"], ["html", { outputFolder: "dist/playwright/report", open: "never" }]]
    : "list",
  outputDir: "dist/playwright/results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "phone-375", testIgnore: IDENTITY_SPEC, use: PHONE },
    { name: "desktop-1280", testIgnore: IDENTITY_SPEC, use: DESKTOP },
    {
      name: "identity-phone-375",
      testMatch: IDENTITY_SPEC,
      use: { ...PHONE, baseURL: `http://localhost:${IDENTITY_PORT}` },
    },
    {
      name: "identity-desktop-1280",
      testMatch: IDENTITY_SPEC,
      use: { ...DESKTOP, baseURL: `http://localhost:${IDENTITY_PORT}` },
    },
  ],
  webServer: [
    {
      command: `VITE_FARSIDE_DEMO=1 vite build --outDir dist/e2e && vite preview --outDir dist/e2e --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
    {
      command: `${IDENTITY_ENV} vite build --outDir dist/e2e-identity && vite preview --outDir dist/e2e-identity --port ${IDENTITY_PORT} --strictPort`,
      url: `http://localhost:${IDENTITY_PORT}`,
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
