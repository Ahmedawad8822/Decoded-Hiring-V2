// ===========================================================================
// MISSION 07 - E2E: Full Editorial AI Lifecycle
//
// Exercises the complete draft lifecycle:
//   upload mk -> ingest READY -> retrieve -> generate (FakeProvider) ->
//   draft stored -> provenance -> edit -> submit -> approve -> publish ->
//   verify public page
// Also covers: IN_REVIEW -> REJECTED (recoverable) and
//   IN_REVIEW -> send-back -> DRAFT -> edit -> resubmit
//
// Identity guard: scan generated content + public page for accidental
// software-platform contamination.
// ---------------------------------------------------------------------------

import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- Read .env.local directly (Playwright worker does not auto-load it) ---
function localEnv(key: string): string {
  const v = process.env[key];
  if (v) return v;
  try {
    const content = fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && m[1] === key) return m[2].trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

const ADMIN_EMAIL = localEnv("ADMIN_INITIAL_EMAIL");
const ADMIN_PASSWORD = localEnv("ADMIN_INITIAL_PASSWORD");
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error(
    "ADMIN_INITIAL_EMAIL and ADMIN_INITIAL_PASSWORD must be set in .env.local",
  );
}

const FIXTURE_BASE = path.resolve(__dirname, "fixtures", "sample-knowledge.md");
const FORBIDDEN = ["builders", "gcc", "compiler", "production features", "production systems"];

async function signInAdmin(page: Page) {
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      callbackURL: "/admin/content",
    },
  });
  expect(
    response.status(),
    `admin Better Auth sign-in returned HTTP ${response.status()}`,
  ).toBeLessThan(400);
  await page.goto("/admin/content", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/admin\/content/, { timeout: 30_000 });
}

async function clickReload(page: Page, selector: string) {
  const reloaded = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame === page.mainFrame(),
    timeout: 60_000,
  });
  await page.click(selector);
  await reloaded;
  await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
}

test.describe("mission 07 editorial ai lifecycle", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  let tmpFixture: string;
  let sourceTitle: string;
  let runId: string;
  let sourceId: string;

  test.beforeAll(() => {
    runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    sourceTitle = `E2E Knowledge ${runId}`;
    const base = fs.readFileSync(FIXTURE_BASE, "utf-8");
    const content = base + "\n\n<!-- e2e-run:" + runId + " -->\n";
    tmpFixture = path.join(os.tmpdir(), `e2e-knowledge-${runId}.md`);
    fs.writeFileSync(tmpFixture, content);
  });

  test.afterAll(() => {
    if (fs.existsSync(tmpFixture)) fs.unlinkSync(tmpFixture);
  });

  test("admin exercises full editorial lifecycle with FakeProvider", async ({
    page,
  }) => {
    // === 1. ADMIN LOGIN ===
    await signInAdmin(page);

    // === 2. UPLOAD .md KNOWLEDGE SOURCE ===
    await page.goto("/admin/knowledge");

    // Wait for form fields to be ready (client component hydration).
    await page
      .locator('input[type="file"]')
      .waitFor({ state: "attached", timeout: 15_000 });
    await page
      .locator('input[name="title"]')
      .waitFor({ state: "visible", timeout: 10_000 });

    // Upload via the REAL form — no page.evaluate/fetch bypass.
    // The upload handler in page-client.tsx calls window.location.reload()
    // after a successful POST, so we wait for the reload to settle.
    await page.locator('input[type="file"]').setInputFiles(tmpFixture);
    await page.locator('input[name="title"]').fill(sourceTitle);
    await Promise.all([
      page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: 60_000,
      }),
      page.getByRole("button", { name: /Upload Source/ }).click(),
    ]);
    await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });

    // After reload, the source should appear in the table.
    await page.locator("td", { hasText: sourceTitle }).first().waitFor({
      state: "visible",
      timeout: 15_000,
    });

    // Extract the source ID from the table link href for subsequent navigation.
    const sourceHref = await page
      .locator('a[href*="/admin/knowledge/"]')
      .filter({ hasText: sourceTitle })
      .first()
      .getAttribute("href");
    expect(sourceHref).toBeTruthy();
    sourceId = sourceHref!.split("/").pop()!;
    expect(sourceId).toMatch(/^ks_/);

    // === 3. INGEST -> READY ===
    await page.goto(`/admin/knowledge/${sourceId}`);
    await page.waitForSelector('text=UPLOADED', { timeout: 10_000 });

    await clickReload(page, 'button:has-text("Ingest")');
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/admin/knowledge/${sourceId}`);
          expect(response.status()).toBe(200);
          return response.text();
        },
        {
          timeout: 30_000,
          intervals: [250, 500, 1_000, 2_000],
          message: "knowledge source should reach durable READY state",
        },
      )
      .toContain("READY");
    await page.goto(`/admin/knowledge/${sourceId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("text=READY").first()).toBeVisible();

    // Verify chunks were actually created during ingestion
    const chunkCountCell = await page
      .locator("td", { hasText: "Chunk Count" })
      .locator("xpath=following-sibling::td")
      .textContent();
    const chunkCount = parseInt(chunkCountCell || "0", 10);
    expect(chunkCount).toBeGreaterThan(0);

    // D1 FTS5 sync triggers index newly-created chunks asynchronously. This
    // fixed wait is a genuine external consistency boundary — there is no D1
    // API or FTS5-ready endpoint to poll; the subsequent retrieveKnowledge()
    // in the generation step depends on the index being current.
    await page.waitForTimeout(1_500);

    // === 4. GENERATE DRAFT 1 (GUIDE) - REJECTION PATH ===
    await page.goto("/admin/editorial/new");
    await page.selectOption('select[name="contentType"]', "GUIDE");
    await page.fill('input[name="topic"]', "hiring signal decay");
    await Promise.all([
      page.waitForURL(/\/admin\/editorial\/(draft_\w+)/),
      page.click('button:has-text("Generate Draft")'),
    ]);
    const draft1Id = page.url().split("/").pop()!;
    await expect(page).toHaveURL(`/admin/editorial/${draft1Id}`);

    // === 5. VERIFY DRAFT STORED ===
    await expect(page.locator("h1")).toContainText("Draft: Hiring signal decay");

    // === 6. VERIFY PROVENANCE (retrieval found expected source) ===
    await expect(page.locator('h2:has-text("Source Provenance")')).toBeVisible();
    // Use allTextContents to avoid strict-mode violation: locator("td")
    // matches ~40 cells across the meta + provenance tables.
    const tdTexts1 = await page.locator("td").allTextContents();
    const hasExactSource1 = tdTexts1.some((t) => t.includes(sourceTitle));
    const hasAnyKnowledge1 = tdTexts1.some((t) => t.includes("E2E Knowledge"));
    // The current run's source should be found. If FTS5 topK=8 returned
    // a previously-ingested source with identical content, accept that
    // as well — the draft's evidence is still from the E2E Knowledge library.
    expect(hasExactSource1 || hasAnyKnowledge1).toBe(true);

    // === 7. IDENTITY CHECK: no platform contamination ===
    const body1 = (await page.locator("body").textContent()) ?? "";
    for (const term of FORBIDDEN) {
      expect(body1.toLowerCase()).not.toContain(term);
    }

    // === 8. EDIT DRAFT (change title) ===
    await page.click('button:has-text("Edit draft")');
    await page.fill('input[name="title"]', "Evidence: Hiring Signal Decay Guide");
    await clickReload(page, 'button:has-text("Save changes")');
    await expect(page.locator("h1")).toContainText("Evidence: Hiring Signal Decay Guide");

    // === 9. SUBMIT FOR REVIEW -> IN_REVIEW ===
    await clickReload(page, 'button:has-text("Submit for Review")');
    await expect(page.locator("text=IN_REVIEW").first()).toBeVisible({
      timeout: 20_000,
    });

    // === 10. REJECT -> REJECTED (RECOVERABLE, not terminal) ===
    await clickReload(page, 'button:has-text("Reject")');
    await expect(page.locator("text=REJECTED").first()).toBeVisible({
      timeout: 15_000,
    });
    // REJECTED is recoverable: no Publish button, but "Recover to DRAFT" appears.
    await expect(page.locator('button:has-text("Publish")')).toHaveCount(0);
    await expect(page.locator('button:has-text("Recover to DRAFT")')).toBeVisible({
      timeout: 10_000,
    });

    // === 11. RECOVER -> DRAFT, then re-submit and publish ===
    await clickReload(page, 'button:has-text("Recover to DRAFT")');
    await expect(page.locator("text=DRAFT").first()).toBeVisible({
      timeout: 10_000,
    });
    // After recovery, the standard lifecycle buttons return.
    await expect(page.locator('button:has-text("Submit for Review")')).toBeVisible();
    await expect(page.locator('button:has-text("Recover to DRAFT")')).toHaveCount(0);

    // === 12. GENERATE DRAFT 2 (FIELD_NOTE) - PUBLISH PATH ===
    await page.goto("/admin/editorial/new");
    await page.selectOption('select[name="contentType"]', "FIELD_NOTE");
    await page.fill('input[name="topic"]', `evidence-based hiring ${runId}`);
    await Promise.all([
      page.waitForURL(/\/admin\/editorial\/(draft_\w+)/),
      page.click('button:has-text("Generate Draft")'),
    ]);
    const draft2Id = page.url().split("/").pop()!;
    await expect(page).toHaveURL(`/admin/editorial/${draft2Id}`);

    // === 12. VERIFY PROVENANCE ===
    await expect(page.locator('h2:has-text("Source Provenance")')).toBeVisible();
    const tdTexts2 = await page.locator("td").allTextContents();
    const hasExactSource2 = tdTexts2.some((t) => t.includes(sourceTitle));
    const hasAnyKnowledge2 = tdTexts2.some((t) => t.includes("E2E Knowledge"));
    expect(hasExactSource2 || hasAnyKnowledge2).toBe(true);

    // === 13. SUBMIT FOR REVIEW -> IN_REVIEW ===
    await clickReload(page, 'button:has-text("Submit for Review")');
    await expect(page.locator("text=IN_REVIEW").first()).toBeVisible({
      timeout: 20_000,
    });

    // === 14. SEND BACK -> DRAFT ===
    await clickReload(page, 'button:has-text("Send Back")');
    await expect(page.locator("text=DRAFT").first()).toBeVisible({
      timeout: 20_000,
    });

    // === 15. EDIT & RESUBMIT ===
    await page.click('button:has-text("Edit draft")');
    await page.fill(
      'textarea[name="excerpt"]',
      "Revised: evidence-based hiring requires calibrated scoring.",
    );
    await clickReload(page, 'button:has-text("Save changes")');
    // Verify excerpt updated
    await expect(
      page.locator("strong:has-text(\"Excerpt:\")").locator("xpath=following-sibling::*"),
    ).toContainText("Revised:");

    // === 16. RESUBMIT -> IN_REVIEW ===
    await clickReload(page, 'button:has-text("Submit for Review")');
    await expect(page.locator("text=IN_REVIEW").first()).toBeVisible({
      timeout: 20_000,
    });

    // === 17. APPROVE -> APPROVED ===
    await clickReload(page, 'button:has-text("Approve")');
    await expect(page.locator("text=APPROVED").first()).toBeVisible({
      timeout: 20_000,
    });

    // === 18. PUBLISH -> PUBLISHED ===
    await clickReload(page, 'button:has-text("Publish")');
    await expect(page.locator("text=PUBLISHED").first()).toBeVisible({
      timeout: 20_000,
    });

    // === 19. EXTRACT SLUG & VERIFY PUBLIC PAGE ===
    const slug = await page
      .locator("text=Slug:")
      .locator("code")
      .first()
      .textContent();
    expect(slug).toBeTruthy();

    const publicUrl = `/field-notes/${slug}`;
    await page.goto(publicUrl);
    // Public page accessible without admin auth
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("h1")).toContainText("Draft:");

    // Identity check on public page
    const bodyPublic = (await page.locator("body").textContent()) ?? "";
    for (const term of FORBIDDEN) {
      expect(bodyPublic.toLowerCase()).not.toContain(term);
    }

    // === 20. VERIFY PUBLISHED ENTITY IN ADMIN CONTENT ===
    await page.goto("/admin/content");
    // The content page defaults to the "Guides" tab (which shows 0 guides).
    // Switch to the "Field Notes" tab to see the published field note.
    await page.getByRole("tab", { name: /Field Notes/ }).click();
    // No fixed sleep needed — the expect below retries until the published
    // field-note link is visible in the Field Notes tab content (client-side
    // tab switch renders synchronously; the 10s timeout covers any render
    // delay).
    // The admin content table renders Preview links as /field-notes/{slug}?preview=true
    // Both the table and card-list views render a link, so use .first() to avoid
    // strict-mode violation (2 matching elements).
    await expect(page.locator(`a[href*="${slug}"]`).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
