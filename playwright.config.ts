import { defineConfig, devices } from "@playwright/test";

// Base URL stays http://localhost:3000 by default per local QA convention.
// When 3000 is already taken, run with E2E_PORT=<free-port>, e.g.
// E2E_PORT=3100 npm run test:e2e
const port = Number(process.env.E2E_PORT ?? 3000);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  // Remediation F: the certification run must report 0 retries required. A
  // cold-server race is handled deterministically in the spec (single
  // re-submission), so local runs retry nothing; CI keeps its 2-retry safety.
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // EXPLICIT TEST-ONLY: enable FakeProvider injection in generateDraftAction
    // so the E2E suite runs without real LLM API credentials. This env gate
    // is opt-in and documented — production code never sets it.
    env: {
      EDITORIAL_FORCE_FAKE_PROVIDER: "1",
      // EXPLICIT TEST-ONLY: the E2E suite signs in repeatedly from one
      // loopback IP; the app ignores this when NODE_ENV is "production".
      DH_AUTH_RATE_LIMIT_DISABLED: "1",
      // EXPLICIT TEST-ONLY: the seeded e2e admin has no TOTP enrolled, so the
      // G3 admin 2FA gate is off here. Production leaves it enforced.
      ADMIN_REQUIRE_2FA: "false",
    },
  },
});
