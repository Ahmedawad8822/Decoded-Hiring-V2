import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { clickAction, waitForHydration } from "./helpers/actions";
import { generateCertificateId } from "../src/features/certificates/types";

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
// The first completion compiles the progress server action on the dev server
// and writes to D1, which can take well over the 5 s default on a slow CI
// runner. Wait longer, but fail fast with the button's own error if it shows one.
async function completeAndContinue(page: Page, expectedPath: string, mobile = false) {
  const row = page.locator(mobile ? ".ls-mobile-bar" : ".ls-actions");
  await clickAction(page, row.getByRole("button", { name: "Complete & continue", exact: true }));
  await expect(page).toHaveURL(new RegExp(`${expectedPath}$`), { timeout: 30_000 });
  // Scope to #main: Next's client route announcer (outside #main) is itself role="alert".
  await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
}

async function signInAdmin(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/admin/login");
  await waitForHydration(page, page.getByLabel(/Admin Email/));
  await page.getByLabel(/Admin Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await clickAction(page, page.getByRole("button", { name: "Sign in to Studio" }));
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
    let certificatePath = "";

    // ---- ADMIN FLOW ----
    await test.step("admin login", async () => {
      await signInAdmin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    });

    await test.step("create draft FREE course", async () => {
      await page.goto("/admin/courses");
      await expect(page.getByRole("heading", { name: "Courses" })).toBeVisible();
      await clickAction(page, page.getByRole("button", { name: "＋ New course" }));
      await waitForHydration(page, page.getByLabel("Course title"));
      await page.getByLabel("Course title").fill(courseTitle);
      await page.getByLabel("Course slug").fill(courseSlug);
      await page.getByLabel("Course description").fill("End-to-end lifecycle course.");
      await page.getByLabel("Access mode").selectOption("FREE");
      await page.getByLabel("Issue certificates on completion").check();
      await page.getByLabel("Learning outcomes").fill("Build a clear learning plan");
      await page.getByLabel("Course audience").fill("Learners exploring the course");
      await page.getByLabel("Instructor name", { exact: true }).fill("Course instructor");
      await page.getByLabel("Instructor bio", { exact: true }).fill("Practical course guidance.");
      await clickAction(page, page.getByRole("button", { name: "Add FAQ", exact: true }));
      await page.getByLabel("Question 1", { exact: true }).fill("Can I try a lesson?");
      await page.getByLabel("Answer 1", { exact: true }).fill("Yes, open the free preview before enrolling.");
      await clickAction(page, page.getByRole("button", { name: "Create draft" }));
      await expect(page.getByText(courseTitle).first()).toBeVisible();
    });

    await test.step("add section + two required lessons", async () => {
      await page.getByRole("link", { name: "Curriculum →" }).first().click();
      await expect(page.getByText(courseTitle).first()).toBeVisible();
      await waitForHydration(page, page.getByLabel("New section title"));
      await page.getByLabel("New section title").fill("E2E Section");
      await clickAction(page, page.getByRole("button", { name: "＋ Add section" }));
      await expect(page.getByText("E2E Section").first()).toBeVisible();

      await clickAction(page, page.getByRole("button", { name: "＋ Add lesson" }));
      await waitForHydration(page, page.getByLabel("New lesson title"));
      await page.getByLabel("New lesson title").fill("First Lesson E2E");
      await page.getByLabel("New lesson slug").fill(lesson1Slug);
      await clickAction(page, page.getByRole("button", { name: "Add lesson" }));
      await expect(page.getByText("First Lesson E2E").first()).toBeVisible();

      await clickAction(page, page.getByRole("button", { name: "＋ Add lesson" }));
      await waitForHydration(page, page.getByLabel("New lesson title"));
      await page.getByLabel("New lesson title").fill("Second Lesson E2E");
      await page.getByLabel("New lesson slug").fill(lesson2Slug);
      await clickAction(page, page.getByRole("button", { name: "Add lesson" }));
      await expect(page.getByText("Second Lesson E2E").first()).toBeVisible();
    });

    await test.step("set preview and duration through the lesson editor", async () => {
      await clickAction(page, page.getByRole("row", { name: /First Lesson E2E/ }).getByRole("button", { name: "Edit", exact: true }));
      await waitForHydration(page, page.getByLabel("Free preview", { exact: true }));
      await page.getByLabel("Free preview", { exact: true }).check();
      await page.getByLabel("Length (minutes)", { exact: true }).fill("8");
      await clickAction(page, page.getByRole("button", { name: "Save lesson", exact: true }));
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
    });

    await test.step("attach PDF resource to lesson 1", async () => {
      const row = page.getByRole("row", { name: /First Lesson E2E/ });
      await clickAction(page, row.getByRole("button", { name: "＋ PDF" }));
      await waitForHydration(page, page.getByLabel("Resource title"));
      await page.locator('input[type="file"]').setInputFiles("e2e/fixtures/sample.pdf");
      await page.getByLabel("Resource title").fill("E2E Worksheet");
      await clickAction(page, page.getByRole("button", { name: "Upload PDF" }));
      await expect(page.getByText("enrolled learners can download it")).toBeVisible();
    });

    await test.step("publish lessons + course, verify enrollment CTA", async () => {
      await clickAction(page, page.getByRole("row", { name: /First Lesson E2E/ }).getByRole("button", { name: "Publish" }));
      await expect(page.getByText("live for learners on next load")).toBeVisible();
      await clickAction(page, page.getByRole("row", { name: /Second Lesson E2E/ }).getByRole("button", { name: "Publish" }));
      await page.goto("/admin/courses");
      await clickAction(page, page.locator(`[data-course-slug="${courseSlug}"]`).getByRole("button", { name: "Publish", exact: true }));
      await expect(page.locator(`[data-course-slug="${courseSlug}"]`).getByText("PUBLISHED")).toBeVisible({ timeout: 30_000 });
      // Authenticated but unenrolled admin sees the enrollment CTA = available.
      await page.goto(`/learn/courses/${courseSlug}`);
      await expect(page.getByRole("button", { name: "Start free — enroll now" })).toBeVisible();
    });

    // ---- LEARNER FLOW ----
    await test.step("log out admin, sign up learner, empty state", async () => {
      await page.context().clearCookies();
      await page.goto("/signup");
      await waitForHydration(page, page.getByRole("button", { name: "Create account" }));
      await page.getByLabel(/Name/).fill("E2E Learner");
      await page.getByLabel(/Email/).fill(learnerEmail);
      await page.getByLabel(/^Password/).fill("e2e-password-123");
      await clickAction(page, page.getByRole("button", { name: "Create account" }));
      await expect(page).toHaveURL(/\/learn/, { timeout: 90_000 });
      await expect(page.getByText("No enrollments yet")).toBeVisible();
      const explore = page.getByRole("region", { name: "Explore more courses" });
      await expect(explore).toBeVisible();
      await expect(explore.getByRole("link")).toHaveCount(2);
      await expect(explore.getByText(/lessons/).first()).toBeVisible();
    });

    await test.step("signed-in non-enrolled learner opens preview; other lessons and files stay gated", async () => {
      const response = await page.goto(`/learn/courses/${courseSlug}`);
      expect(response?.headers()["cache-control"]).toContain("no-store");
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      await expect(page.getByText("Build a clear learning plan", { exact: true })).toBeVisible();
      await page.getByText("Can I try a lesson?", { exact: true }).click();
      await expect(page.getByText("Yes, open the free preview before enrolling.", { exact: true })).toBeVisible();
      const preview = page.locator(".cu-lesson", { hasText: "First Lesson E2E" });
      await expect(preview.getByText("Preview", { exact: true })).toBeVisible();
      await expect(preview).toContainText("Reading · 8 min");
      await expect(preview).toHaveAttribute("href", `/learn/courses/${courseSlug}/lessons/${lesson1Slug}`);
      await page.setViewportSize({ width: 375, height: 900 });
      const enrollBar = page.getByRole("region", { name: "Course enrollment", exact: true });
      await expect(enrollBar.getByRole("button", { name: "Start free — enroll now" })).toBeVisible();
      const bar = await enrollBar.boundingBox();
      const tabs = await page.locator(".lrn-tabs").boundingBox();
      expect(bar!.y + bar!.height).toBeLessThanOrEqual(tabs!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: "test-results/learner-conversion-overview-phone.png", fullPage: true });
      await preview.click();
      await expect(page.getByRole("heading", { name: "First Lesson E2E" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Complete & continue" })).toHaveCount(0);
      await expect(page.locator(".ls-mobile-bar").getByRole("link", { name: "Enroll in course →" })).toBeVisible();
      await expect(page.getByRole("link", { name: /Download/ })).toHaveCount(0);
      await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
      await page.screenshot({ path: "test-results/learner-conversion-preview-phone.png", fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lesson2Slug}`);
      await expect(page.getByRole("heading", { name: "Enrollment required" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Complete & continue" })).toHaveCount(0);
    });

    await test.step("enroll free, appears in my courses", async () => {
      await page.goto(`/learn/courses/${courseSlug}`);
      await clickAction(page, page.getByRole("button", { name: "Start free — enroll now" }));
      await expect(page.getByText("Continue where you left off")).toBeVisible();
      await expect(page.getByText("8 min left", { exact: true })).toBeVisible();
      await page.goto("/learn/courses");
      await expect(page.getByText(courseTitle).first()).toBeVisible();
    });

    await test.step("incomplete completion redirects, newest enrollment is spotlight", async () => {
      await page.goto(`/learn/courses/${courseSlug}/complete`);
      await expect(page).toHaveURL(new RegExp(`/learn/courses/${courseSlug}$`));
      await page.goto("/learn");
      await expect(page.locator("a.continue-card")).toContainText(courseTitle);
      const explore = page.getByRole("region", { name: "Explore more courses" });
      await expect(explore).toBeVisible();
      await expect(explore.locator(`a[href="/learn/courses/${courseSlug}"]`)).toHaveCount(0);
      await page.goto("/learn/courses/mission-01-demo");
      await clickAction(page, page.getByRole("button", { name: "Start free — enroll now" }));
      await expect(page.getByText("Continue where you left off")).toBeVisible();
      await page.goto("/learn");
      await expect(page.locator("a.continue-card")).toContainText("Mission 01");
    });

    await test.step("open lesson 1, download protected PDF, complete", async () => {
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lesson1Slug}`);
      await expect(page.getByRole("heading", { name: "First Lesson E2E" })).toBeVisible();
      await page.locator(".ls-actions").getByRole("link", { name: "Next →", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Second Lesson E2E" })).toBeVisible();
      await expect(page.locator(".ls-actions").getByRole("link", { name: "Finish →" })).toHaveAttribute("href", `/learn/courses/${courseSlug}`);
      await page.locator(".ls-actions").getByRole("link", { name: "← Previous" }).click();
      await expect(page.locator(".ls-actions").getByRole("button", { name: "Complete & continue", exact: true })).toBeVisible();
      const dlLink = page.getByRole("link", { name: /Download/ }).first();
      resourceHref = (await dlLink.getAttribute("href")) ?? "";
      expect(resourceHref).toMatch(/^\/api\/course-resources\//);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        dlLink.click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
      await completeAndContinue(page, `/learn/courses/${courseSlug}/lessons/${lesson2Slug}`);
    });

    await test.step("latest activity wins spotlight; completed lessons can continue", async () => {
      await expect(page.getByRole("heading", { name: "Second Lesson E2E" })).toBeVisible();
      await page.goto("/learn");
      await expect(page.locator("a.continue-card")).toContainText(courseTitle);
      await expect(page.getByRole("region", { name: "My courses" }).locator("a.course-card").first()).toContainText(courseTitle);
      await page.screenshot({ path: "test-results/learner-batch-a-dashboard.png", fullPage: true });
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lesson1Slug}`);
      await expect(page.locator(".ls-actions").getByText("Completed ✓")).toBeVisible();
      await page.locator(".ls-actions").getByRole("link", { name: "Continue →", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/lessons/${lesson2Slug}$`));
    });

    await test.step("phone complete action opens completion, dashboard and overview link back", async () => {
      await page.setViewportSize({ width: 375, height: 900 });
      await completeAndContinue(page, `/learn/courses/${courseSlug}/complete`, true);
      await expect(page.getByRole("heading", { name: "You did it." })).toBeVisible();
      await expect(page.getByText(courseTitle, { exact: true })).toBeVisible();
      await expect(page.getByText("Completed on")).toBeVisible();
      await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
      await expect(page.getByText("Downloadable resources")).toBeVisible();
      await expect(page.getByRole("heading", { name: "What's next" })).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex.*nofollow/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: "test-results/learner-batch-a-completion-phone.png", fullPage: true });
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lesson2Slug}`);
      await page.locator(".ls-mobile-bar").getByRole("link", { name: "See completion" }).click();
      await expect(page).toHaveURL(new RegExp(`/courses/${courseSlug}/complete$`));
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lesson2Slug}`);
      await expect(page.locator(".ls-actions").getByRole("link", { name: "Finish →" })).toHaveAttribute("href", `/learn/courses/${courseSlug}/complete`);
      await page.goto(`/learn/courses/${courseSlug}`);
      await expect(page.getByText("Course complete", { exact: true })).toBeVisible();
      await expect(page.getByText("100%").first()).toBeVisible();
      await page.getByRole("link", { name: "See your completion" }).click();
      await expect(page).toHaveURL(new RegExp(`/courses/${courseSlug}/complete$`));
      await page.goto("/learn");
      const completed = page.getByRole("region", { name: "Completed", exact: true });
      await expect(completed.getByRole("link", { name: "See completion" })).toHaveAttribute("href", `/learn/courses/${courseSlug}/complete`);
      await expect(completed.getByRole("link", { name: "Review", exact: true })).toBeVisible();
    });

    await test.step("claim certificate, verify anonymously, and print a single landscape page", async () => {
      await page.goto(`/learn/courses/${courseSlug}/complete`);
      const name = page.getByLabel("Name on certificate");
      await waitForHydration(page, name);
      await expect(name).toHaveValue("E2E Learner");
      await name.fill("Certificate Learner");
      await clickAction(page, page.getByRole("button", { name: "Get your certificate", exact: true }));
      await expect(page).toHaveURL(/\/certificates\/[0-9A-HJKMNP-TV-Z]{26}$/);
      certificatePath = new URL(page.url()).pathname;
      await expect(page.getByText("Valid", { exact: true })).toBeVisible();
      await expect(page.getByText("Certificate Learner", { exact: true })).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex.*nofollow/);
      expect((await page.request.get(certificatePath)).headers()["cache-control"]).toContain("no-store");
      expect(await page.locator("#main").innerText()).not.toContain(learnerEmail);
      await page.evaluate(() => { window.print = () => { document.body.dataset.printCalled = "true"; }; });
      await clickAction(page, page.getByRole("button", { name: "Print / Save as PDF" }));
      await expect(page.locator("body")).toHaveAttribute("data-print-called", "true");
      await page.emulateMedia({ media: "print" });
      await expect(page.getByRole("button", { name: "Print / Save as PDF" })).toBeHidden();
      const pdf = await page.pdf({ path: "test-results/course-certificate.pdf", preferCSSPageSize: true });
      const pdfSource = pdf.toString("latin1");
      expect(pdfSource.match(/\/Type \/Page\b/g)).toHaveLength(1);
      const mediaBox = pdfSource.match(/\/MediaBox \[([\d. ]+)\]/)?.[1].split(/\s+/).map(Number);
      expect(mediaBox).toBeDefined();
      expect(mediaBox![2]).toBeGreaterThan(mediaBox![3]);
      await page.screenshot({ path: "test-results/course-certificate-print.png", fullPage: true });
      // Maximum allowed copy must still fit on one landscape sheet.
      await page.evaluate(() => {
        document.querySelector(".certificate-recipient")!.textContent = "W".repeat(80);
        document.querySelector(".certificate-sheet h2")!.textContent = "W".repeat(160);
        const reason = document.createElement("p");
        reason.className = "certificate-reason";
        reason.textContent = "W".repeat(200);
        document.querySelector(".certificate-status")!.after(reason);
      });
      const longestPdf = await page.pdf({ path: "test-results/course-certificate-max-copy.pdf", preferCSSPageSize: true });
      expect(longestPdf.toString("latin1").match(/\/Type \/Page\b/g)).toHaveLength(1);
      await page.emulateMedia({ media: "screen" });
      await page.goto(`/learn/courses/${courseSlug}/complete`);
      await expect(page.getByRole("link", { name: "View certificate", exact: true })).toHaveAttribute("href", certificatePath);
      await expect(page.getByLabel("Name on certificate")).toHaveCount(0);
      await page.goto(`/learn/courses/${courseSlug}`);
      await expect(page.getByRole("link", { name: "Certificate", exact: true })).toHaveAttribute("href", certificatePath);
      await page.goto("/learn");
      await expect(page.getByRole("region", { name: "Certificates", exact: true }).getByRole("link", { name: courseTitle })).toHaveAttribute("href", certificatePath);
    });

    await test.step("public verification follows Studio corrections, revocation and restoration immediately", async () => {
      const origin = new URL(page.url()).origin;
      const browser = page.context().browser()!;
      const anonymous = await browser.newContext({ baseURL: origin });
      const studio = await browser.newContext({ baseURL: origin });
      try {
        const verify = await anonymous.newPage();
        const first = await verify.goto(certificatePath);
        expect(first?.status()).toBe(200);
        expect(first?.headers()["cache-control"]).toContain("no-store");
        await expect(verify.getByText("Valid", { exact: true })).toBeVisible();
        const admin = await studio.newPage();
        await signInAdmin(admin, ADMIN_EMAIL, ADMIN_PASSWORD);
        await admin.goto("/admin/courses");
        await admin.locator(`[data-course-slug="${courseSlug}"]`).getByRole("link", { name: "Certificates →", exact: true }).click();
        await waitForHydration(admin, admin.getByLabel("Edit recipient name"));
        await admin.getByLabel("Edit recipient name").fill("Corrected Learner");
        await clickAction(admin, admin.getByRole("button", { name: "Save recipient name" }));
        await expect(admin.getByRole("heading", { name: "Corrected Learner", exact: true })).toBeVisible();
        await admin.getByLabel("Revocation reason").fill("<b>Review required</b>");
        await clickAction(admin, admin.getByRole("button", { name: "Revoke", exact: true }));
        await expect(admin.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
        await verify.reload();
        await expect(verify.getByText(/Revoked on/)).toBeVisible();
        await expect(verify.getByText("<b>Review required</b>", { exact: true })).toBeVisible();
        await expect(verify.locator(".certificate-reason b")).toHaveCount(0);
        await expect(verify.getByText("Corrected Learner", { exact: true })).toBeVisible();
        await clickAction(admin, admin.getByRole("button", { name: "Restore", exact: true }));
        await expect(admin.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
        await verify.reload();
        await expect(verify.getByText("Valid", { exact: true })).toBeVisible();
        await expect(verify.locator(".certificate-reason")).toHaveCount(0);
        for (const id of [generateCertificateId(), "malformed"]) {
          expect((await verify.goto(`/certificates/${id}`))?.status()).toBe(404);
        }
        await expect(admin.locator("#main").getByRole("alert")).toHaveCount(0);
      } finally { await anonymous.close(); await studio.close(); }
    });

    // ---- SECURITY FLOW ----
    await test.step("anonymous lesson + resource denied", async () => {
      await page.context().clearCookies();
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lesson1Slug}`);
      await expect(page).toHaveURL(/\/login/);
      const res = await page.request.get(resourceHref);
      expect(res.status()).toBe(401);
      await page.goto(`/learn/courses/${courseSlug}/complete`);
      await expect(page).toHaveURL(/\/login/);
    });

    await test.step("unenrolled learner lesson + resource denied", async () => {
      await page.goto("/signup");
      await waitForHydration(page, page.getByRole("button", { name: "Create account" }));
      await page.getByLabel(/Name/).fill("E2E Learner Two");
      await page.getByLabel(/Email/).fill(learner2Email);
      await page.getByLabel(/^Password/).fill("e2e-password-123");
      await clickAction(page, page.getByRole("button", { name: "Create account" }));
      await expect(page).toHaveURL(/\/learn/, { timeout: 90_000 });
      await page.goto(`/learn/courses/${courseSlug}/lessons/${lesson2Slug}`);
      await expect(page.getByText("Enrollment required")).toBeVisible();
      await expect(page.getByRole("button", { name: "Complete & continue" })).toHaveCount(0);
      const res = await page.request.get(resourceHref);
      expect(res.status()).toBe(403);
      await page.goto(`/learn/courses/${courseSlug}/complete`);
      await expect(page.getByRole("heading", { name: "Enrollment required" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "You did it." })).toHaveCount(0);
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
      await clickAction(page, page.locator(`[data-course-slug="${courseSlug}"]`).getByRole("button", { name: "Archive" }));
      await clickAction(page, page.getByRole("button", { name: "Confirm Archive", exact: true }));
      await expect(page.locator(`[data-course-slug="${courseSlug}"]`).getByText("ARCHIVED", { exact: true })).toBeVisible();
    });
  });

  test("responsive learner matrix has no horizontal overflow", async ({ page }) => {
    test.setTimeout(240_000);
    const widths = [320, 375, 430, 768, 1024, 1280, 1440, 1728];
    const run = Date.now().toString(36);
    await page.goto("/signup");
    await waitForHydration(page, page.getByRole("button", { name: "Create account" }));
    await page.getByLabel(/Name/).fill("E2E Responsive");
    await page.getByLabel(/Email/).fill(`e2e-responsive-${run}@example.com`);
    await page.getByLabel(/^Password/).fill("e2e-password-123");
    await clickAction(page, page.getByRole("button", { name: "Create account" }));
    await expect(page).toHaveURL(/\/learn/, { timeout: 90_000 });

    const urls = [
      "/login",
      "/learn",
      "/learn/courses",
      "/learn/courses/mission-01-demo",
      "/learn/courses/mission-01-demo/complete",
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
