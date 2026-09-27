import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

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

// Remediation F: credentials are guaranteed by scripts/e2e-bootstrap.ts, which
// runs before the suite (`npm run test:e2e`) and FAILS LOUDLY when the admin
// account cannot be provisioned. The central lifecycle test must never
// silently skip, so missing credentials abort the whole run here instead.
test.beforeAll(async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      "E2E prerequisites missing: ADMIN_INITIAL_EMAIL/ADMIN_INITIAL_PASSWORD are not set. " +
        "Run `npm run test:e2e` (which bootstraps them via scripts/e2e-bootstrap.ts) — the " +
        "Mission 06 lifecycle test must never silently skip."
    );
  }
});

// Warm the cold routes explicitly before any test uses signInAdmin.
// This replaces the hidden second login submission inside signInAdmin().
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    // Hit the admin login page to warm route handlers and auth middleware.
    await page.goto("/admin/login", { waitUntil: "domcontentloaded", timeout: 30_000 });
    // A simple wait for the form to be visible is enough to warm the route.
    await page.getByLabel(/Admin Email/).waitFor({ state: "visible", timeout: 10_000 });

    // Warm the Better Auth API routes too. A browser POST against a freshly
    // started `next dev` can race a route handler's FIRST compile; the
    // dropped response stream ("destination stream closed early") leaves the
    // UI stuck with no error. Compile every auth handler the suite exercises
    // here with harmless payloads — 4xx on invalid payloads means the handler
    // ran and is now warm. Fail loudly if a route is unavailable instead of
    // flaking later.
    for (const [path, payload] of [
      ["/api/auth/sign-in/email", {}],
      ["/api/auth/sign-up/email", {}],
    ] as const) {
      const warmRes = await page.request.post(path, { data: payload });
      const status = warmRes.status();
      if (status < 400 || status > 499) {
        throw new Error(`auth route warm-up failed (POST ${path} -> HTTP ${status})`);
      }
    }
    const sessionWarm = await page.request.get("/api/auth/get-session");
    if (sessionWarm.status() > 499) {
      throw new Error(`auth session warm-up failed with HTTP ${sessionWarm.status()}`);
    }

    // Warm the post-login redirect target so the first real navigation after
    // sign-in never waits on /admin/content's first compile (it redirects to
    // /admin/login while unauthenticated — that IS the warm render). This is
    // BEST-EFFORT: on a cold server the very first compile of this heavy page
    // can take long enough that the browser aborts the navigation
    // (ERR_ABORTED). The server-side compile continues, so the warm still
    // serves its purpose — and the real assertions all carry their own
    // generous timeouts, so a dropped warm must never fail the suite.
    try {
      await page.goto("/admin/content", { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch {
      // Ignore: aborted best-effort warm; the target compiles server-side.
    }
  } finally {
    await page.close();
  }
});

// Cold-server sign-in: on the first hit against a freshly started `next dev`,
// the Better Auth sign-in POST can race route-handler compilation and fail
// once (the UI then shows the error state while still on /admin/login).
// One deterministic re-submission after the routes are warm removes the flake
// without inflating timeouts or weakening any assertion.
// FIXED: Warm the cold route explicitly in test setup instead of retrying
// the user action inside the test.
async function signInAdmin(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/admin/login");
  await page.getByLabel(/Admin Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in to Studio" }).click();
  await expect(page).toHaveURL(/\/admin\/content/, { timeout: 90_000 });
}

test.describe("mission 06 learning platform lifecycle", () => {
  test.describe.configure({ mode: "serial" });
  test("admin builds course, learner completes it, boundaries hold", async ({ page }) => {
    test.setTimeout(240_000);
    const run = Date.now().toString(36);
    const courseSlug = `e2e-course-${run}`;
    const courseTitle = `E2E Course ${run}`;
    const lesson1Slug = `e2e-first-lesson-${run}`;
    const lesson2Slug = `e2e-second-lesson-${run}`;
    const learnerEmail = `e2e-learner-${run}@example.com`;
    const learner2Email = `e2e-learner2-${run}@example.com`;
    let resourceHref = "";

    // ---- ADMIN FLOW ----
    await test.step("admin login", async () => {
      await signInAdmin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    });

    await test.step("create draft FREE course", async () => {
      await page.goto("/admin/courses");
      await expect(page.getByRole("heading", { name: "Courses" })).toBeVisible();
      await page.getByRole("button", { name: "＋ New course" }).click();
      await page.getByLabel("Course title").fill(courseTitle);
      await page.getByLabel("Course slug").fill(courseSlug);
      await page.getByLabel("Course description").fill("End-to-end lifecycle course.");
      await page.getByLabel("Access mode").selectOption("FREE");
      await page.getByRole("button", { name: "Create draft" }).click();
      await expect(page.getByText(courseTitle).first()).toBeVisible();
    });

    await test.step("add section + two required lessons", async () => {
      await page.getByRole("link", { name: "Curriculum →" }).first().click();
      await expect(page.getByText(courseTitle).first()).toBeVisible();
      await page.getByLabel("New section title").fill("E2E Section");
      await page.getByRole("button", { name: "＋ Add section" }).click();
      await expect(page.getByText("E2E Section").first()).toBeVisible();

      await page.getByRole("button", { name: "＋ Add lesson" }).click();
      await page.getByLabel("New lesson title").fill("First Lesson E2E");
      await page.getByLabel("New lesson slug").fill(lesson1Slug);
      await page.getByRole("button", { name: "Add lesson" }).click();
      await expect(page.getByText("First Lesson E2E").first()).toBeVisible();

      await page.getByRole("button", { name: "＋ Add lesson" }).click();
      await page.getByLabel("New lesson title").fill("Second Lesson E2E");
      await page.getByLabel("New lesson slug").fill(lesson2Slug);
      await page.getByRole("button", { name: "Add lesson" }).click();
      await expect(page.getByText("Second Lesson E2E").first()).toBeVisible();
    });

    await test.step("attach PDF resource to lesson 1", async () => {
      const row = page.getByRole("row", { name: /First Lesson E2E/ });
      await row.getByRole("button", { name: "＋ PDF" }).click();
      await page.locator('input[type="file"]').setInputFiles("e2e/fixtures/sample.pdf");
      await page.getByLabel("Resource title").fill("E2E Worksheet");
      await page.getByRole("button", { name: "Upload PDF" }).click();
      await expect(page.getByText("enrolled learners can download it")).toBeVisible();
    });

    await test.step("publish lessons + course, verify enrollment CTA", async () => {
      await page.getByRole("row", { name: /First Lesson E2E/ }).getByRole("button", { name: "Publish" }).click();
      await expect(page.getByText("live for learners on next load")).toBeVisible();
      await page.getByRole("row", { name: /Second Lesson E2E/ }).getByRole("button", { name: "Publish" }).click();
      await page.goto("/admin/courses");
      await page.locator(`[data-course-slug="${courseSlug}"]`).getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.locator(`[data-course-slug="${courseSlug}"]`).getByText("PUBLISHED")).toBeVisible({ timeout: 30_000 });
      // Authenticated but unenrolled admin sees the enrollment CTA = available.
      await page.goto(`/learn/courses/${courseSlug}`);
      await expect(page.getByRole("button", { name: "Start free — enroll now" })).toBeVisible();
    });

    // ---- LEARNER FLOW ----
    await test.step("log out admin, sign up learner, empty state", async () => {
      await page.context().clearCookies();
      await page.goto("/signup");
      await page.getByLabel(/Name/).fill("E2E Learner");
      await page.getByLabel(/Email/).fill(learnerEmail);
      await page.getByLabel(/^Password/).fill("e2e-password-123");
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page).toHaveURL(/\/learn/, { timeout: 90_000 });
      await expect(page.getByText("No enrollments yet")).toBeVisible();
    });

    await test.step("enroll free, appears in my courses", async () => {
      await page.goto(`/learn/courses/${courseSlug}`);
      await page.getByRole("button", { name: "Start free — enroll now" }).click();
      await expect(page.getByText("Continue where you left off")).toBeVisible();
      await page.goto("/learn/courses");
      await expect(page.getByText(courseTitle).first()).toBeVisible();
    });

    await test.step("open lesson 1, download protected PDF, complete", async () => {
      await page.goto(`/learn/courses/${courseSlug}`, {
        waitUntil: "domcontentloaded",
      });
      const lesson1Link = page
        .getByRole("link", { name: /First Lesson E2E/ })
        .first();
      await expect(lesson1Link).toBeVisible({ timeout: 30_000 });
      await lesson1Link.click();
      await expect(page).toHaveURL(
        new RegExp(`/learn/courses/${courseSlug}/lessons/${lesson1Slug}import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

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

// Remediation F: credentials are guaranteed by scripts/e2e-bootstrap.ts, which
// runs before the suite (`npm run test:e2e`) and FAILS LOUDLY when the admin
// account cannot be provisioned. The central lifecycle test must never
// silently skip, so missing credentials abort the whole run here instead.
test.beforeAll(async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      "E2E prerequisites missing: ADMIN_INITIAL_EMAIL/ADMIN_INITIAL_PASSWORD are not set. " +
        "Run `npm run test:e2e` (which bootstraps them via scripts/e2e-bootstrap.ts) — the " +
        "Mission 06 lifecycle test must never silently skip."
    );
  }
});

// Warm the cold routes explicitly before any test uses signInAdmin.
// This replaces the hidden second login submission inside signInAdmin().
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    // Hit the admin login page to warm route handlers and auth middleware.
    await page.goto("/admin/login", { waitUntil: "domcontentloaded", timeout: 30_000 });
    // A simple wait for the form to be visible is enough to warm the route.
    await page.getByLabel(/Admin Email/).waitFor({ state: "visible", timeout: 10_000 });

    // Warm the Better Auth API routes too. A browser POST against a freshly
    // started `next dev` can race a route handler's FIRST compile; the
    // dropped response stream ("destination stream closed early") leaves the
    // UI stuck with no error. Compile every auth handler the suite exercises
    // here with harmless payloads — 4xx on invalid payloads means the handler
    // ran and is now warm. Fail loudly if a route is unavailable instead of
    // flaking later.
    for (const [path, payload] of [
      ["/api/auth/sign-in/email", {}],
      ["/api/auth/sign-up/email", {}],
    ] as const) {
      const warmRes = await page.request.post(path, { data: payload });
      const status = warmRes.status();
      if (status < 400 || status > 499) {
        throw new Error(`auth route warm-up failed (POST ${path} -> HTTP ${status})`);
      }
    }
    const sessionWarm = await page.request.get("/api/auth/get-session");
    if (sessionWarm.status() > 499) {
      throw new Error(`auth session warm-up failed with HTTP ${sessionWarm.status()}`);
    }

    // Warm the post-login redirect target so the first real navigation after
    // sign-in never waits on /admin/content's first compile (it redirects to
    // /admin/login while unauthenticated — that IS the warm render). This is
    // BEST-EFFORT: on a cold server the very first compile of this heavy page
    // can take long enough that the browser aborts the navigation
    // (ERR_ABORTED). The server-side compile continues, so the warm still
    // serves its purpose — and the real assertions all carry their own
    // generous timeouts, so a dropped warm must never fail the suite.
    try {
      await page.goto("/admin/content", { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch {
      // Ignore: aborted best-effort warm; the target compiles server-side.
    }
  } finally {
    await page.close();
  }
});

// Cold-server sign-in: on the first hit against a freshly started `next dev`,
// the Better Auth sign-in POST can race route-handler compilation and fail
// once (the UI then shows the error state while still on /admin/login).
// One deterministic re-submission after the routes are warm removes the flake
// without inflating timeouts or weakening any assertion.
// FIXED: Warm the cold route explicitly in test setup instead of retrying
// the user action inside the test.
async function signInAdmin(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/admin/login");
  await page.getByLabel(/Admin Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Sign in to Studio" }).click();
  await expect(page).toHaveURL(/\/admin\/content/, { timeout: 90_000 });
}

test.describe("mission 06 learning platform lifecycle", () => {
  test.describe.configure({ mode: "serial" });
  test("admin builds course, learner completes it, boundaries hold", async ({ page }) => {
    test.setTimeout(240_000);
    const run = Date.now().toString(36);
    const courseSlug = `e2e-course-${run}`;
    const courseTitle = `E2E Course ${run}`;
    const lesson1Slug = `e2e-first-lesson-${run}`;
    const lesson2Slug = `e2e-second-lesson-${run}`;
    const learnerEmail = `e2e-learner-${run}@example.com`;
    const learner2Email = `e2e-learner2-${run}@example.com`;
    let resourceHref = "";

    // ---- ADMIN FLOW ----
    await test.step("admin login", async () => {
      await signInAdmin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    });

    await test.step("create draft FREE course", async () => {
      await page.goto("/admin/courses");
      await expect(page.getByRole("heading", { name: "Courses" })).toBeVisible();
      await page.getByRole("button", { name: "＋ New course" }).click();
      await page.getByLabel("Course title").fill(courseTitle);
      await page.getByLabel("Course slug").fill(courseSlug);
      await page.getByLabel("Course description").fill("End-to-end lifecycle course.");
      await page.getByLabel("Access mode").selectOption("FREE");
      await page.getByRole("button", { name: "Create draft" }).click();
      await expect(page.getByText(courseTitle).first()).toBeVisible();
    });

    await test.step("add section + two required lessons", async () => {
      await page.getByRole("link", { name: "Curriculum →" }).first().click();
      await expect(page.getByText(courseTitle).first()).toBeVisible();
      await page.getByLabel("New section title").fill("E2E Section");
      await page.getByRole("button", { name: "＋ Add section" }).click();
      await expect(page.getByText("E2E Section").first()).toBeVisible();

      await page.getByRole("button", { name: "＋ Add lesson" }).click();
      await page.getByLabel("New lesson title").fill("First Lesson E2E");
      await page.getByLabel("New lesson slug").fill(lesson1Slug);
      await page.getByRole("button", { name: "Add lesson" }).click();
      await expect(page.getByText("First Lesson E2E").first()).toBeVisible();

      await page.getByRole("button", { name: "＋ Add lesson" }).click();
      await page.getByLabel("New lesson title").fill("Second Lesson E2E");
      await page.getByLabel("New lesson slug").fill(lesson2Slug);
      await page.getByRole("button", { name: "Add lesson" }).click();
      await expect(page.getByText("Second Lesson E2E").first()).toBeVisible();
    });

    await test.step("attach PDF resource to lesson 1", async () => {
      const row = page.getByRole("row", { name: /First Lesson E2E/ });
      await row.getByRole("button", { name: "＋ PDF" }).click();
      await page.locator('input[type="file"]').setInputFiles("e2e/fixtures/sample.pdf");
      await page.getByLabel("Resource title").fill("E2E Worksheet");
      await page.getByRole("button", { name: "Upload PDF" }).click();
      await expect(page.getByText("enrolled learners can download it")).toBeVisible();
    });

    await test.step("publish lessons + course, verify enrollment CTA", async () => {
      await page.getByRole("row", { name: /First Lesson E2E/ }).getByRole("button", { name: "Publish" }).click();
      await expect(page.getByText("live for learners on next load")).toBeVisible();
      await page.getByRole("row", { name: /Second Lesson E2E/ }).getByRole("button", { name: "Publish" }).click();
      await page.goto("/admin/courses");
      await page.locator(`[data-course-slug="${courseSlug}"]`).getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.locator(`[data-course-slug="${courseSlug}"]`).getByText("PUBLISHED")).toBeVisible({ timeout: 30_000 });
      // Authenticated but unenrolled admin sees the enrollment CTA = available.
      await page.goto(`/learn/courses/${courseSlug}`);
      await expect(page.getByRole("button", { name: "Start free — enroll now" })).toBeVisible();
    });

    // ---- LEARNER FLOW ----
    await test.step("log out admin, sign up learner, empty state", async () => {
      await page.context().clearCookies();
      await page.goto("/signup");
      await page.getByLabel(/Name/).fill("E2E Learner");
      await page.getByLabel(/Email/).fill(learnerEmail);
      await page.getByLabel(/^Password/).fill("e2e-password-123");
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page).toHaveURL(/\/learn/, { timeout: 90_000 });
      await expect(page.getByText("No enrollments yet")).toBeVisible();
    });

    await test.step("enroll free, appears in my courses", async () => {
      await page.goto(`/learn/courses/${courseSlug}`);
      await page.getByRole("button", { name: "Start free — enroll now" }).click();
      await expect(page.getByText("Continue where you left off")).toBeVisible();
      await page.goto("/learn/courses");
      await expect(page.getByText(courseTitle).first()).toBeVisible();
    });

),
        { timeout: 30_000 },
      );
      await expect(
        page.getByRole("heading", { name: "First Lesson E2E" }),
      ).toBeVisible({ timeout: 30_000 });
      const dlLink = page.getByRole("link", { name: /Download/ }).first();
      resourceHref = (await dlLink.getAttribute("href")) ?? "";
      expect(resourceHref).toMatch(/^\/api\/course-resources\//);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        dlLink.click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
      await page.getByRole("button", { name: "Mark lesson complete" }).first().click();
      await expect(page.getByText("✓ Completed").first()).toBeVisible();
    });

    await test.step("next lesson, complete course", async () => {
      await page.getByRole("link", { name: /^Next/ }).first().click();
      await expect(page.getByRole("heading", { name: "Second Lesson E2E" })).toBeVisible();
      await page.getByRole("button", { name: "Mark lesson complete" }).first().click();
      await expect(page.getByText("✓ Completed").first()).toBeVisible();
      await page.goto(`/learn/courses/${courseSlug}`);
      await expect(page.getByText("Course complete")).toBeVisible();
      await expect(page.getByText("100%").first()).toBeVisible();
    });

    // ---- SECURITY FLOW ----
    await test.step("anonymous lesson + resource denied", async () => {
      await page.context().clearCookies();
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lesson1Slug}`);
      await expect(page).toHaveURL(/\/login/);
      const res = await page.request.get(resourceHref);
      expect(res.status()).toBe(401);
    });

    await test.step("unenrolled learner lesson + resource denied", async () => {
      await page.goto("/signup");
      await page.getByLabel(/Name/).fill("E2E Learner Two");
      await page.getByLabel(/Email/).fill(learner2Email);
      await page.getByLabel(/^Password/).fill("e2e-password-123");
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page).toHaveURL(/\/learn/, { timeout: 90_000 });
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lesson1Slug}`);
      await expect(page.getByText("Enrollment required")).toBeVisible();
      await expect(page.getByRole("button", { name: "Mark lesson complete" })).toHaveCount(0);
      const res = await page.request.get(resourceHref);
      expect(res.status()).toBe(403);
    });

    await test.step("normal user cannot use admin routes", async () => {
      await page.goto("/admin/courses");
      await expect(page).toHaveURL(/\/admin\/login/);
    });

    // ---- ADMIN REGRESSION ----
    await test.step("guide + field notes admin + admin login still work", async () => {
      await page.context().clearCookies();
      await signInAdmin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto("/admin/content");
      await expect(page.getByRole("main")).toBeVisible();
    });

    // ---- CLEANUP ----
    await test.step("archive temporary e2e course", async () => {
      await page.goto("/admin/courses");
      await page.locator(`[data-course-slug="${courseSlug}"]`).getByRole("button", { name: "Archive" }).click();
      await expect(page.getByText(courseTitle).first()).toBeVisible();
    });
  });

  test("responsive learner matrix has no horizontal overflow", async ({ page }) => {
    test.setTimeout(240_000);
    const widths = [320, 375, 430, 768, 1024, 1280, 1440, 1728];
    const run = Date.now().toString(36);
    await page.goto("/signup");
    await page.getByLabel(/Name/).fill("E2E Responsive");
    await page.getByLabel(/Email/).fill(`e2e-responsive-${run}@example.com`);
    await page.getByLabel(/^Password/).fill("e2e-password-123");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/learn/, { timeout: 90_000 });

    const urls = [
      "/login",
      "/learn",
      "/learn/courses",
      "/learn/courses/mission-01-demo",
      "/learn/courses/mission-01-demo/lessons/why-role-clarity-fails",
    ];
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 900 });
      for (const url of urls) {
        await page.goto(url);
        const overflow = await page.evaluate(() => {
          const el = document.scrollingElement ?? document.documentElement;
          return el.scrollWidth - window.innerWidth;
        });
        expect(overflow, `${url} @ ${w}px`).toBeLessThanOrEqual(1);
      }
    }
  });
});
