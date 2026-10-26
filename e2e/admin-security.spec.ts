import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { clickAction } from "./helpers/actions";

// G3: /admin/security renders for a signed-in admin (e2e runs with
// ADMIN_REQUIRE_2FA=false, so the rest of the Studio is not gated).
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

test("admin security page renders the 2FA status and enable button", async ({ page }) => {
  test.setTimeout(150_000);
  const email = localEnv("ADMIN_INITIAL_EMAIL");
  const password = localEnv("ADMIN_INITIAL_PASSWORD");
  test.skip(!email || !password, "needs ADMIN_INITIAL_EMAIL/ADMIN_INITIAL_PASSWORD (npm run test:e2e bootstraps them)");

  await page.goto("/admin/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel(/Admin Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  // One hydration-aware click: retrying sign-in would trip the 5/min sign-in rate limit.
  await clickAction(page, page.getByRole("button", { name: "Sign in to Studio" }));
  await expect(page).toHaveURL(/\/admin\/content/, { timeout: 90_000 });

  await page.goto("/admin/security", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Security" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("twofa-status")).toContainText("Not enabled");
  await expect(page.getByRole("button", { name: "Enable two-factor authentication" })).toBeVisible();
});
