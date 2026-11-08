import { defineConfig, devices } from "@playwright/test";
import { workerPort } from "./scripts/worker-e2e-setup";

const port = workerPort();
export default defineConfig({
  testDir: "./e2e-worker",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "test-results/worker",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // HTTP/ISR tests use APIRequestContext only, so they also work where Chromium
  // cannot launch. All projects use the same built Worker + SQLite DO queue.
  projects: [{ name: "worker-chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Avoid the tsx CLI signal-forwarding parent: the harness must finish
    // stopping its detached Worker and deleting state before it exits.
    command: "node --import tsx scripts/worker-e2e-server.ts",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    stdout: "pipe",
    timeout: 360_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
