import { test, expect } from "@playwright/test";

test.describe("public smoke", () => {
  test("homepage renders", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Decoded Hiring/);
    await expect(page.getByRole("main").first()).toBeVisible();
  });

  test("guides index renders", async ({ page }) => {
    await page.goto("/guides");
    await expect(page).toHaveTitle(/Guides/);
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toBeVisible();
  });

  test("admin login form renders", async ({ page }) => {
    await page.goto("/admin/login");
    await expect(
      page.getByRole("heading", { name: "Studio sign-in" }),
    ).toBeVisible();
    await expect(page.getByLabel(/Admin Email/)).toBeVisible();
    await expect(page.getByLabel(/^Password/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in to Studio" }),
    ).toBeVisible();
  });
});
