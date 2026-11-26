import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { completeSignupVerification } from "./helpers/verification";
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
        "Run `npm run test:e2e` (which bootstraps them via scripts/e2e-bootstrap.ts).",
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

test.describe("drip release learner experience", () => {
  test("a drip lesson shows Unlocks in the outline and stays locked on its page", async ({ page }) => {
    test.setTimeout(240_000);
    const run = Date.now().toString(36);
    const courseSlug = `e2e-drip-course-${run}`;
    const courseTitle = `E2E Drip Course ${run}`;
    const openSlug = `e2e-drip-open-${run}`;
    const dripSlug = `e2e-drip-locked-${run}`;
    const learnerEmail = `e2e-drip-learner-${run}@example.com`;

    await test.step("admin builds a course with one drip lesson", async () => {
      await signInAdmin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto("/admin/courses");
      await expect(page.getByRole("heading", { name: "Courses" })).toBeVisible();
      await clickAction(page, page.getByRole("button", { name: "＋ New course" }));
      await waitForHydration(page, page.getByLabel("Course title"));
      await page.getByLabel("Course title").fill(courseTitle);
      await page.getByLabel("Course slug").fill(courseSlug);
      await page.getByLabel("Course description").fill("Drip release end-to-end course.");
      await page.getByLabel("Access mode").selectOption("FREE");
      await clickAction(page, page.getByRole("button", { name: "Create draft" }));
      await expect(page.getByText(courseTitle).first()).toBeVisible();

      await page.getByRole("link", { name: "Curriculum →" }).first().click();
      await expect(page.getByText(courseTitle).first()).toBeVisible();
      await waitForHydration(page, page.getByLabel("New section title"));
      await page.getByLabel("New section title").fill("Drip Section");
      await clickAction(page, page.getByRole("button", { name: "＋ Add section" }));
      await expect(page.getByText("Drip Section").first()).toBeVisible();

      await clickAction(page, page.getByRole("button", { name: "＋ Add lesson" }));
      await waitForHydration(page, page.getByLabel("New lesson title"));
      await page.getByLabel("New lesson title").fill("Open Lesson Drip E2E");
      await page.getByLabel("New lesson slug").fill(openSlug);
      await clickAction(page, page.getByRole("button", { name: "Add lesson" }));
      await expect(page.getByText("Open Lesson Drip E2E").first()).toBeVisible();

      await clickAction(page, page.getByRole("button", { name: "＋ Add lesson" }));
      await waitForHydration(page, page.getByLabel("New lesson title"));
      await page.getByLabel("New lesson title").fill("Locked Lesson Drip E2E");
      await page.getByLabel("New lesson slug").fill(dripSlug);
      await clickAction(page, page.getByRole("button", { name: "Add lesson" }));
      await expect(page.getByText("Locked Lesson Drip E2E").first()).toBeVisible();
    });

    await test.step("set the second lesson to drip 30 days via Studio", async () => {
      await clickAction(page, page.getByRole("row", { name: /Locked Lesson Drip E2E/ }).getByRole("button", { name: "Edit", exact: true }));
      await waitForHydration(page, page.getByLabel("Lesson release mode"));
      await page.getByLabel("Lesson release mode").selectOption("drip");
      await page.getByLabel("Lesson drip days").fill("30");
      await clickAction(page, page.getByRole("button", { name: "Save release", exact: true }));
      await expect(page.getByText("Lesson release updated.")).toBeVisible();
      // Badge also lands on the curriculum list row.
      await clickAction(page, page.getByRole("button", { name: "Close", exact: true }));
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByText("Unlocks day 30").first()).toBeVisible();
    });

    await test.step("publish lessons + course", async () => {
      // Wait for each publish to land before moving on: navigating away while
      // the server action is in flight can abort it on a slow runner.
      for (const title of [/Open Lesson Drip E2E/, /Locked Lesson Drip E2E/]) {
        const row = page.getByRole("row", { name: title });
        await clickAction(page, row.getByRole("button", { name: "Publish" }));
        await expect(row.getByRole("button", { name: "Unpublish" })).toBeVisible({ timeout: 30_000 });
      }
      await page.goto("/admin/courses");
      await clickAction(page, page.locator(`[data-course-slug="${courseSlug}"]`).getByRole("button", { name: "Publish", exact: true }));
      await expect(page.locator(`[data-course-slug="${courseSlug}"]`).getByText("PUBLISHED")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("learner signs up and enrolls", async () => {
      await page.context().clearCookies();
      await page.goto("/signup");
      await waitForHydration(page, page.getByRole("button", { name: "Create account" }));
      await page.getByLabel(/Name/).fill("E2E Drip Learner");
      await page.getByLabel(/Email/).fill(learnerEmail);
      await page.getByLabel(/^Password/).fill("e2e-password-123");
      await clickAction(page, page.getByRole("button", { name: "Create account" }));
      await completeSignupVerification(page, learnerEmail);
      await page.goto(`/learn/courses/${courseSlug}`);
      await clickAction(page, page.getByRole("button", { name: "Start free — enroll now" }));
      await expect(page.getByText("Continue where you left off")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("outline shows Unlocks for the drip lesson", async () => {
      const lockedRow = page.locator("#main .cu-lesson", { hasText: "Locked Lesson Drip E2E" });
      await expect(lockedRow.getByText(/Unlocks/)).toBeVisible();
      const openRow = page.locator("#main .cu-lesson", { hasText: "Open Lesson Drip E2E" });
      await expect(openRow.getByText(/Unlocks/)).toHaveCount(0);
    });

    await test.step("drip lesson page is locked; open lesson serves", async () => {
      await page.goto(`/learn/courses/${courseSlug}/lessons/${dripSlug}`);
      await expect(page.locator("#main").getByText(/unlocks/i).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Complete & continue" })).toHaveCount(0);
      await expect(page.locator("#main").getByRole("link", { name: "Back to course →" })).toBeVisible();

      await page.goto(`/learn/courses/${courseSlug}/lessons/${openSlug}`);
      await expect(page.getByRole("heading", { name: "Open Lesson Drip E2E" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Complete & continue" })).toBeVisible();
    });
  });
});
