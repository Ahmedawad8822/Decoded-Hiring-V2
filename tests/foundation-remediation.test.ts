/**
 * FOUNDATION REMEDIATION REGRESSIONS (gates A.8, B.2, B.4, D, E)
 * ---------------------------------------------------------------------------
 * - A.8: production application/runtime must not reference /prototypes paths
 *   (the deleted public/prototypes static tree), except historical docs.
 * - B.2/B.4: sitemap contains static public routes + PUBLISHED guides/field
 *   notes only; draft and archived slugs must never leak.
 * - D: guide lifecycle guard — archived is terminal, mirrors Field Notes.
 * - E: guide/field-note slug UNIQUE races convert to friendly domain errors;
 *   unrelated DB errors propagate untouched.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { getDb, guides, fieldNotes } from "../src/lib/db";
import { eq } from "drizzle-orm";
import {
  createGuide,
  updateGuide,
  publishGuide,
  unpublishGuide,
  archiveGuide,
  getPublishedGuides,
} from "../src/features/guides/service";
import {
  createFieldNote,
  publishFieldNote,
  archiveFieldNote,
} from "../src/features/field-notes/service";
import {
  assertGuideTransition,
} from "../src/features/publishing/lifecycle";
import { buildSitemapEntries } from "../src/lib/sitemap-entries";

const SRC_DIR = path.resolve(import.meta.dirname, "../src");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A.8 — no prototype runtime coupling in application source
// ---------------------------------------------------------------------------
test("A8: no src/ application file references /prototypes runtime paths", () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    if (!/\.(ts|tsx|css|js|mjs)$/.test(file)) continue;
    const content = fs.readFileSync(file, "utf-8");
    // Any import/url reference to the prototype CSS/HTML/JS tree.
    if (/["'`(]\/?prototypes\//.test(content) || /["'`]\/prototypes\//.test(content)) {
      offenders.push(path.relative(SRC_DIR, file));
    }
  }
  assert.deepEqual(offenders, [], `Prototype references found in: ${offenders.join(", ")}`);
});

test("A8: no deployable public/prototypes static tree exists", () => {
  const publicPrototypes = path.resolve(import.meta.dirname, "../public/prototypes");
  assert.equal(fs.existsSync(publicPrototypes), false, "public/prototypes must not exist");
});

// ---------------------------------------------------------------------------
// D — guide lifecycle guard (mirrors Field Notes: archived is terminal)
// ---------------------------------------------------------------------------
function stamp() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function cleanupGuide(slug: string) {
  const db = await getDb();
  await db.delete(guides).where(eq(guides.slug, slug));
}

async function cleanupFieldNote(slug: string) {
  const db = await getDb();
  await db.delete(fieldNotes).where(eq(fieldNotes.slug, slug));
}

test("D: guide lifecycle guard unit matrix matches the documented transition table", () => {
  assert.doesNotThrow(() => assertGuideTransition("draft", "publish"));
  assert.doesNotThrow(() => assertGuideTransition("draft", "archive"));
  assert.doesNotThrow(() => assertGuideTransition("published", "unpublish"));
  assert.doesNotThrow(() => assertGuideTransition("published", "archive"));
  assert.throws(() => assertGuideTransition("published", "publish"), /"published"/);
  assert.throws(() => assertGuideTransition("draft", "unpublish"), /"draft"/);
  assert.throws(() => assertGuideTransition("archived", "publish"), /archived/i);
  assert.throws(() => assertGuideTransition("archived", "unpublish"), /archived/i);
  assert.throws(() => assertGuideTransition("archived", "archive"), /archived/i);
});

test("D: archived guide is terminal — republish/unpublish/re-archive rejected at service level", async () => {
  const slug = `rem-guide-terminal-${stamp()}`;
  const guide = await createGuide({ title: "Terminal Guide", slug, author: "Ahmed Awad", body: [] });
  await archiveGuide(guide.id);

  await assert.rejects(() => publishGuide(guide.id), /archived/i);
  await assert.rejects(() => unpublishGuide(guide.id), /archived/i);
  await await assert.rejects(() => archiveGuide(guide.id), /archived/i);

  await cleanupGuide(slug);
});

test("D: published guide can unpublish and republish; draft can archive", async () => {
  const slug = `rem-guide-valid-${stamp()}`;
  const guide = await createGuide({ title: "Valid Transitions Guide", slug, author: "Ahmed Awad", body: [] });

  const published = await publishGuide(guide.id);
  assert.equal(published.status, "published");
  assert.ok(published.publishedAt);

  const unpublished = await unpublishGuide(guide.id);
  assert.equal(unpublished.status, "draft");

  const republished = await publishGuide(guide.id);
  assert.equal(republished.status, "published");
  // first-publish-wins preserved
  assert.equal(republished.publishedAt?.getTime(), published.publishedAt?.getTime());

  const archived = await archiveGuide(guide.id);
  assert.equal(archived.status, "archived");

  await cleanupGuide(slug);
});

// ---------------------------------------------------------------------------
// E — UNIQUE-race handling: friendly domain error on real UNIQUE violations
// ---------------------------------------------------------------------------
test("E: duplicate guide slug surfaces the friendly domain error (DB UNIQUE authority)", async () => {
  const slug = `rem-guide-dup-${stamp()}`;
  await createGuide({ title: "First", slug, author: "Ahmed Awad", body: [] });
  // Domain pre-check also catches this; either path must produce the same
  // friendly domain error, never a raw SQLite constraint message.
  await assert.rejects(
    () => createGuide({ title: "Second", slug, author: "Ahmed Awad", body: [] }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /already exists/);
      // Raw driver wording must never leak through the friendly conversion.
      assert.doesNotMatch(message, /UNIQUE constraint|constraint failed|SQLITE_CONSTRAINT/i);
      return true;
    }
  );
  await cleanupGuide(slug);
});

test("E: duplicate field note slug surfaces the friendly domain error", async () => {
  const slug = `rem-fn-dup-${stamp()}`;
  await createFieldNote({ title: "First Note", slug, author: "Ahmed Awad", body: [] });
  await assert.rejects(
    () => createFieldNote({ title: "Second Note", slug, author: "Ahmed Awad", body: [] }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /already exists/);
      assert.doesNotMatch(message, /UNIQUE constraint|constraint failed|SQLITE_CONSTRAINT/i);
      return true;
    }
  );
  await cleanupFieldNote(slug);
});

test("E: guide slug rename race converts to friendly domain error", async () => {
  const slugA = `rem-guide-a-${stamp()}`;
  const slugB = `rem-guide-b-${stamp()}`;
  const a = await createGuide({ title: "Guide A", slug: slugA, author: "Ahmed Awad", body: [] });
  await createGuide({ title: "Guide B", slug: slugB, author: "Ahmed Awad", body: [] });

  // Renaming A onto B's slug trips the domain pre-check path; the friendly
  // error is identical whether the pre-check or the DB UNIQUE wins the race.
  await assert.rejects(
    () => updateGuide(a.id, { id: a.id, slug: slugB }),
    /already exists/
  );

  await cleanupGuide(slugA);
  await cleanupGuide(slugB);
});

// ---------------------------------------------------------------------------
// B.2/B.4 — sitemap content: published only, no draft/archive leakage
// ---------------------------------------------------------------------------
test("B4: sitemap includes static routes + published guides/field notes, excludes drafts and archived", async () => {
  const guideSlug = `rem-sitemap-guide-${stamp()}`;
  const draftGuideSlug = `rem-sitemap-draft-guide-${stamp()}`;
  const noteSlug = `rem-sitemap-note-${stamp()}`;
  const archivedNoteSlug = `rem-sitemap-archived-note-${stamp()}`;

  const guide = await createGuide({ title: "Sitemap Guide", slug: guideSlug, author: "Ahmed Awad", body: [] });
  await publishGuide(guide.id);
  await createGuide({ title: "Draft Guide", slug: draftGuideSlug, author: "Ahmed Awad", body: [] }); // stays draft

  const note = await createFieldNote({ title: "Sitemap Note", slug: noteSlug, author: "Ahmed Awad", body: [] });
  await publishFieldNote(note.id);
  const archivedNote = await createFieldNote({ title: "Archived Note", slug: archivedNoteSlug, author: "Ahmed Awad", body: [] });
  await archiveFieldNote(archivedNote.id);

  try {
    const entries = await buildSitemapEntries();
    const urls = entries.map((e) => e.url);

    assert.ok(urls.some((u) => u.endsWith("/guides")), "sitemap must include /guides");
    assert.ok(urls.some((u) => u.endsWith("/field-notes")), "sitemap must include /field-notes");
    assert.ok(urls.some((u) => u.endsWith(`/guides/${guideSlug}`)), "published guide must appear");
    assert.ok(urls.some((u) => u.endsWith(`/field-notes/${noteSlug}`)), "published note must appear");

    assert.ok(
      !urls.some((u) => u.includes(draftGuideSlug)),
      "draft guide must never leak into the sitemap"
    );
    assert.ok(
      !urls.some((u) => u.includes(archivedNoteSlug)),
      "archived note must never leak into the sitemap"
    );
  } finally {
    await cleanupGuide(guideSlug);
    await cleanupGuide(draftGuideSlug);
    await cleanupFieldNote(noteSlug);
    await cleanupFieldNote(archivedNoteSlug);
  }
});

test("B4: sitemap never contains a non-published guide even if service visibility changes", async () => {
  // Invariant test: every guide-derived sitemap URL must map to a published row.
  const [publishedGuides, entries] = await Promise.all([
    getPublishedGuides(),
    buildSitemapEntries(),
  ]);
  const publishedSlugs = new Set(publishedGuides.map((g) => g.slug));
  for (const entry of entries) {
    const match = entry.url.match(/\/guides\/([^/]+)$/);
    if (match) {
      assert.ok(
        publishedSlugs.has(match[1]),
        `sitemap contains guide "${match[1]}" that is not published`
      );
    }
  }
});
