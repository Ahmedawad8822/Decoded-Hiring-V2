import { test, expect } from "@playwright/test";

test.describe("field notes public", () => {
  test("index renders with heading and breadcrumbs", async ({ page }) => {
    await page.goto("/field-notes");
    await expect(page).toHaveTitle(/Field Notes/);
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Field Notes", level: 1 })).toBeVisible();
  });

  test("unknown slug returns 404", async ({ page }) => {
    const res = await page.goto("/field-notes/this-note-does-not-exist-xyz");
    expect(res?.status()).toBe(404);
  });

  test("draft is never publicly exposed (unknown draft slug 404s)", async ({ page }) => {
    // Slugs are unguessable; any non-published slug must 404 without preview.
    const res = await page.goto("/field-notes/admin-only-draft-probe-xyz");
    expect(res?.status()).toBe(404);
  });
});
