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

// Same fail-loud guarantee as the Mission 06 lifecycle spec: credentials are
// provisioned by scripts/e2e-bootstrap.ts, never silently skipped.
test.beforeAll(async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      "E2E prerequisites missing: ADMIN_INITIAL_EMAIL/ADMIN_INITIAL_PASSWORD are not set. " +
      "Run `npm run test:e2e` (which bootstraps them via scripts/e2e-bootstrap.ts)."
    );
  }
});

async function signInAdmin(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/admin/login");
  await waitForHydration(page, page.getByLabel(/Admin Email/));
  await page.getByLabel(/Admin Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await clickAction(page, page.getByRole("button", { name: "Sign in to Studio" }));
  await expect(page).toHaveURL(/\/admin\/content/, { timeout: 90_000 });
}

test.describe("leave a course", () => {
  test.describe.configure({ mode: "serial" });
  test("enrolled learner leaves, sees the left state, loses access, re-enrolls with progress kept", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const run = Date.now().toString(36);
    const courseSlug = `e2e-leave-${run}`;
    const courseTitle = `E2E Leave ${run}`;
    const lessonSlug = `e2e-leave-lesson-${run}`;
    const learnerEmail = `e2e-leave-learner-${run}@example.com`;

    await test.step("admin creates and publishes a single-lesson FREE course", async () => {
      await signInAdmin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto("/admin/courses");
      await expect(page.getByRole("heading", { name: "Courses" })).toBeVisible();
      await clickAction(page, page.getByRole("button", { name: "＋ New course" }));
      await waitForHydration(page, page.getByLabel("Course title"));
      await page.getByLabel("Course title").fill(courseTitle);
      await page.getByLabel("Course slug").fill(courseSlug);
      await page.getByLabel("Course description").fill("Leave-flow lifecycle course.");
      await page.getByLabel("Access mode").selectOption("FREE");
      await clickAction(page, page.getByRole("button", { name: "Create draft" }));
      await expect(page.getByText(courseTitle).first()).toBeVisible();

      await page.getByRole("link", { name: "Curriculum →" }).first().click();
      await waitForHydration(page, page.getByLabel("New section title"));
      await page.getByLabel("New section title").fill("Leave Section");
      await clickAction(page, page.getByRole("button", { name: "＋ Add section" }));
      await expect(page.getByText("Leave Section").first()).toBeVisible();
      await clickAction(page, page.getByRole("button", { name: "＋ Add lesson" }));
      await waitForHydration(page, page.getByLabel("New lesson title"));
      await page.getByLabel("New lesson title").fill("Only Lesson");
      await page.getByLabel("New lesson slug").fill(lessonSlug);
      await clickAction(page, page.getByRole("button", { name: "Add lesson" }));
      await expect(page.getByText("Only Lesson").first()).toBeVisible();
      await clickAction(page, page.getByRole("row", { name: /Only Lesson/ }).getByRole("button", { name: "Publish" }));
      await expect(page.getByText("live for learners on next load")).toBeVisible();
      await page.goto("/admin/courses");
      await clickAction(page, page.locator(`[data-course-slug="${courseSlug}"]`).getByRole("button", { name: "Publish", exact: true }));
      await expect(page.locator(`[data-course-slug="${courseSlug}"]`).getByText("PUBLISHED")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("learner signs up, enrolls and completes the lesson", async () => {
      await page.context().clearCookies();
      await page.goto("/signup");
      await waitForHydration(page, page.getByRole("button", { name: "Create account" }));
      await page.getByLabel(/Name/).fill("E2E Leave Learner");
      await page.getByLabel(/Email/).fill(learnerEmail);
      await page.getByLabel(/^Password/).fill("e2e-password-123");
      await clickAction(page, page.getByRole("button", { name: "Create account" }));
      await expect(page).toHaveURL(/\/learn/, { timeout: 90_000 });

      await page.goto(`/learn/courses/${courseSlug}`);
      await clickAction(page, page.getByRole("button", { name: "Start free — enroll now" }));
      await expect(page.getByText("Continue where you left off")).toBeVisible();

      await page.goto(`/learn/courses/${courseSlug}/lessons/${lessonSlug}`);
      await expect(page.getByRole("heading", { name: "Only Lesson" })).toBeVisible();
      const row = page.locator(".ls-actions");
      await clickAction(page, row.getByRole("button", { name: "Complete & continue", exact: true }));
      await expect(page).toHaveURL(new RegExp(`/learn/courses/${courseSlug}/complete$`), { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "You did it." })).toBeVisible();
    });

    await test.step("learner leaves the course through the confirm step", async () => {
      await page.setViewportSize({ width: 375, height: 900 });
      await page.goto(`/learn/courses/${courseSlug}`);
      await expect(page.getByText("Course complete", { exact: true })).toBeVisible();
      const leaveTrigger = page.getByRole("button", { name: "Leave course", exact: true });
      await waitForHydration(page, leaveTrigger);
      await expect(leaveTrigger).toBeVisible();
      // Keyboard-operated throughout: the control sits at the very bottom of
      // the page where the fixed mobile tab bar would cover a pointer click
      // point (a real user scrolls it into a tappable position instead).
      // Tab order reaches it and Enter opens the confirm step.
      await leaveTrigger.focus();
      await expect(leaveTrigger).toBeFocused();
      await page.keyboard.press("Enter");

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Your progress, notes and certificates are kept.")).toBeVisible();
      // Focus moves into the confirm step.
      await expect(dialog).toBeFocused();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);

      // Escape cancels and returns focus to the trigger.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(leaveTrigger).toBeFocused();

      await leaveTrigger.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      // Tab moves from the dialog container to the danger confirm button.
      await page.keyboard.press("Tab");
      const confirmLeave = page.getByRole("dialog").getByRole("button", { name: "Leave course", exact: true });
      await expect(confirmLeave).toBeFocused();
      await page.keyboard.press("Enter");
      // The course page re-renders the left state: enroll CTA plus the kept-progress note.
      await expect(page.getByText(/You left this course on/)).toBeVisible({ timeout: 30_000 });
      // The enroll CTA renders twice at phone width (card + fixed enroll bar).
      await expect(page.getByRole("button", { name: "Start free — enroll now" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Leave course", exact: true })).toHaveCount(0);
      await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await test.step("lesson access is lost and the dashboard no longer lists the course", async () => {
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lessonSlug}`);
      await expect(page.getByText("Enrollment required")).toBeVisible();
      await expect(page.getByRole("button", { name: "Complete & continue" })).toHaveCount(0);
      await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);

      await page.goto("/learn");
      await expect(page.getByText("No enrollments yet")).toBeVisible();
    });

    await test.step("re-enrolling restores completed state with progress kept", async () => {
      await page.goto(`/learn/courses/${courseSlug}`);
      await clickAction(page, page.getByRole("button", { name: "Start free — enroll now" }));
      // All required lessons were already complete, so the course reads complete again.
      await expect(page.getByText("Course complete", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("100%").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Leave course", exact: true })).toBeVisible();
      await expect(page.getByText(/You left this course on/)).toHaveCount(0);
      await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);

      await page.goto("/learn");
      const completed = page.getByRole("region", { name: "Completed", exact: true });
      await expect(completed.getByText(courseTitle)).toBeVisible();
    });

    await test.step("archive the temporary e2e course", async () => {
      await page.context().clearCookies();
      await signInAdmin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto("/admin/courses");
      await clickAction(page, page.locator(`[data-course-slug="${courseSlug}"]`).getByRole("button", { name: "Archive" }));
      await clickAction(page, page.getByRole("button", { name: "Confirm Archive", exact: true }));
      await expect(page.locator(`[data-course-slug="${courseSlug}"]`).getByText("ARCHIVED", { exact: true })).toBeVisible();
    });
  });
});
