import { test, expect, type Page } from "@playwright/test";
import { clickAction, waitForHydration } from "./helpers/actions";

async function signIn(page: Page) {
  const result = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: `http://localhost:${process.env.E2E_PORT ?? 3000}` },
    data: { email: process.env.ADMIN_INITIAL_EMAIL, password: process.env.ADMIN_INITIAL_PASSWORD },
  });
  expect(result.ok()).toBe(true);
}

test("Home is private, then exposes the real workspace and quick actions", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
  await signIn(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening)/);
  await expect(page.getByRole("region", { name: "Studio overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible();
  await page.getByRole("link", { name: "New guide", exact: true }).click();
  await expect(page.getByLabel(/^Title/)).toBeVisible();
  await expect(page.locator(".bi-body textarea")).toBeVisible();
});

test("Phone navigation traps focus, closes on Escape and navigation, and the topbar fits", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/admin");
  await clickAction(page, page.getByRole("button", { name: "Open navigation" }));
  const drawer = page.getByRole("dialog", { name: "Studio navigation" });
  await expect(drawer).toBeVisible();
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    expect(await drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
  await clickAction(page, page.getByRole("button", { name: "Open navigation" }));
  await drawer.getByRole("link", { name: "Security", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  const fits = await page.locator(".studio-topbar").evaluate(el => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
});

for (const width of [375, 1024, 1280, 1440]) {
  test(`Guide and field-note editors fit at ${width}px`, async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width, height: 1000 });
    for (const intent of ["guide", "field-note"]) {
      await page.goto(`/admin/content?new=${intent}`);
      const title = page.getByLabel(/^Title/);
      await waitForHydration(page, title);
      await title.fill(`Layout check ${intent}`);
      await expect(page.getByRole("button", { name: "Save Draft", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Publish Now", exact: true })).toBeVisible();
      const layout = await page.locator(".publishing-editor").evaluate(el => {
        const main = el.querySelector(".editor-main")!.getBoundingClientRect();
        const aside = el.querySelector(".editor-sidebar")!.getBoundingClientRect();
        const textarea = el.querySelector(".bi-body textarea")!.getBoundingClientRect();
        return { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, mainRight: main.right, asideLeft: aside.left, mainBottom: main.bottom, asideTop: aside.top, bodyWidth: textarea.width, bodyHeight: textarea.height };
      });
      expect(layout.scroll).toBeLessThanOrEqual(layout.width);
      expect(layout.bodyWidth).toBeGreaterThan(width < 760 ? 230 : 430);
      expect(layout.bodyHeight).toBeGreaterThanOrEqual(180);
      if (width >= 1200) expect(layout.mainRight).toBeLessThanOrEqual(layout.asideLeft);
      else expect(layout.mainBottom).toBeLessThanOrEqual(layout.asideTop);
    }
  });
}

test("Learners tab lists enrollments, filters, and links the CSV export", async ({ page }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  const learnerEmail = `e2e-learner-h-${run}@example.com`;

  // A learner row must exist: sign up via the auth API, then enroll in the
  // seeded demo course through the learner UI.
  await page.context().clearCookies();
  const signup = await page.request.post("/api/auth/sign-up/email", {
    headers: { Origin: `http://localhost:${process.env.E2E_PORT ?? 3000}` },
    data: { name: "E2E Learner H", email: learnerEmail, password: "e2e-password-123" },
  });
  expect(signup.ok()).toBe(true);
  await page.goto("/learn/courses/mission-01-demo");
  await waitForHydration(page, page.getByRole("button", { name: "Start free — enroll now" }));
  await clickAction(page, page.getByRole("button", { name: "Start free — enroll now" }));
  await expect(page.getByText("Continue where you left off")).toBeVisible({ timeout: 30_000 });

  // Back to the Studio as admin, open the course's Learners tab.
  await page.context().clearCookies();
  await signIn(page);
  await page.goto("/admin/courses");
  const card = page.locator('[data-course-slug="mission-01-demo"]');
  await waitForHydration(page, card.getByRole("link", { name: /Learners/ }));
  await clickAction(page, card.getByRole("link", { name: /Learners/ }));
  await expect(page).toHaveURL(/\/admin\/courses\/.+\/learners$/, { timeout: 30_000 });

  const main = page.locator("#main");
  await expect(main.getByRole("heading", { level: 1, name: "Learners" })).toBeVisible({ timeout: 30_000 });
  await expect(main.getByText(learnerEmail).first()).toBeVisible({ timeout: 30_000 });

  // Switch a filter: the fresh enrollment is Not started, never Stuck.
  await waitForHydration(page, main.getByRole("link", { name: /Not started/ }));
  await clickAction(page, main.getByRole("link", { name: /Not started/ }));
  await expect(page).toHaveURL(/filter=not-started/, { timeout: 30_000 });
  await expect(main.getByText(learnerEmail).first()).toBeVisible();
  await clickAction(page, main.getByRole("link", { name: /^Stuck/ }));
  await expect(page).toHaveURL(/filter=stuck/, { timeout: 30_000 });
  await expect(main.getByText("No one is stuck. Nice.")).toBeVisible();

  // The Export link carries the current filter into the CSV route.
  const exportHref = await main.getByRole("link", { name: "Export CSV" }).getAttribute("href");
  expect(exportHref).toContain("/learners/export");
  expect(exportHref).toContain("filter=stuck");

  // No horizontal scroll at phone width (cards replace the table).
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
