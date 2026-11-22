import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { clickAction, waitForHydration } from "./helpers/actions";

function localEnv(key: string): string {
  const direct = process.env[key];
  if (direct) return direct;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf-8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
      if (m && m[1] === key) return m[2].trim();
    }
  } catch {
    // ignore
  }
  return "";
}

const ADMIN_EMAIL = localEnv("ADMIN_INITIAL_EMAIL");
const ADMIN_PASSWORD = localEnv("ADMIN_INITIAL_PASSWORD");

test.beforeAll(async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      "E2E prerequisites missing: ADMIN_INITIAL_EMAIL/ADMIN_INITIAL_PASSWORD are not set. " +
      "Run `npm run test:e2e` (which bootstraps them via scripts/e2e-bootstrap.ts)."
    );
  }
});

const GENERIC_MESSAGE = "If an account exists for that email, we've sent a reset link.";

test.describe("password reset", () => {
  test.describe.configure({ mode: "serial" });

  test("login page links to forgot-password", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/login", { timeout: 30_000 });
    const link = page.getByRole("link", { name: "Forgot password?" });
    await waitForHydration(page, link);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/forgot-password");
  });

  test("forgot-password shows the same message for existing and unknown emails", async ({ page }) => {
    test.setTimeout(240_000);
    const run = Date.now().toString(36);

    await test.step("existing account email", async () => {
      await page.goto("/forgot-password", { timeout: 30_000 });
      const email = page.getByLabel(/Email/);
      await waitForHydration(page, email);
      await email.fill(ADMIN_EMAIL);
      await clickAction(page, page.getByRole("button", { name: "Send reset link" }));
      await expect(page.locator("#main").getByText(GENERIC_MESSAGE)).toBeVisible({ timeout: 30_000 });
    });

    await test.step("unknown email shows the identical message", async () => {
      await page.goto("/forgot-password");
      const email = page.getByLabel(/Email/);
      await waitForHydration(page, email);
      await email.fill(`unknown-${run}@example.com`);
      await clickAction(page, page.getByRole("button", { name: "Send reset link" }));
      await expect(page.locator("#main").getByText(GENERIC_MESSAGE)).toBeVisible({ timeout: 30_000 });
    });
  });

  test("reset-password with a bad or missing token shows an error", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 375, height: 900 });

    await test.step("missing token", async () => {
      await page.goto("/reset-password", { timeout: 30_000 });
      const main = page.locator("#main");
      await expect(main.getByText("That link didn’t work.")).toBeVisible();
      await expect(main.getByRole("link", { name: /Request a new reset link/ })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    await test.step("invalid token rejected on submit, with a recovery link", async () => {
      await page.goto("/reset-password?token=bad-token-value", { timeout: 30_000 });
      const password = page.locator("#reset-password");
      await waitForHydration(page, password);
      await password.fill("e2e-new-password-123");
      await page.locator("#reset-confirm").fill("e2e-new-password-123");
      await clickAction(page, page.getByRole("button", { name: "Update password" }));
      const main = page.locator("#main");
      await expect(main.getByText("That link didn’t work.")).toBeVisible({ timeout: 30_000 });
      await expect(main.getByRole("link", { name: /Request a new reset link/ })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    await page.setViewportSize({ width: 1280, height: 900 });
  });
});
