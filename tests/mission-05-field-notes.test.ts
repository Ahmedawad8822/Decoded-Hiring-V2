import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
import { getDb, fieldNotes, fieldNoteRevisions } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  createFieldNote,
  publishFieldNote,
  unpublishFieldNote,
  archiveFieldNote,
  updateFieldNote,
  getPublicFieldNoteBySlug,
  getPublishedFieldNotes,
  getFieldNoteRevisions,
} from "../src/features/field-notes/service";
import { isSafeUrl, isSafeMediaUrl, estimateReadingTime } from "../src/features/publishing/types";
import { assertFieldNoteTransition } from "../src/features/publishing/lifecycle";
import { createFieldNoteSchema } from "../src/features/field-notes/types";
import { createGuideSchema } from "../src/features/guides/types";
import { canPreviewAsAdmin } from "../src/features/publishing/preview";
import { uploadMedia } from "../src/lib/media/service";
import { eq } from "drizzle-orm";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

async function cleanupFieldNote(slug: string) {
  const db = await getDb();
  const note = await db.select().from(fieldNotes).where(eq(fieldNotes.slug, slug)).get();
  if (note) {
    await db.delete(fieldNoteRevisions).where(eq(fieldNoteRevisions.fieldNoteId, note.id));
    await db.delete(fieldNotes).where(eq(fieldNotes.id, note.id));
  }
}

test("FN-1: Anonymous and non-admin users cannot preview drafts", async () => {
  const slug = "fn-security-draft-" + Date.now();
  await createFieldNote({
    title: "Security Test Draft",
    slug,
    excerpt: "Testing field note security boundaries",
    author: "Ahmed Awad",
    body: [],
  });

  const anon = await getPublicFieldNoteBySlug(slug, { preview: true, session: null });
  assert.equal(anon, null, "Anonymous user must not view draft even with preview=true");

  const ordinary = await getPublicFieldNoteBySlug(slug, {
    preview: true,
    session: { user: { id: "u-normal", role: "user" } },
  });
  assert.equal(ordinary, null, "Ordinary user must not view draft even with preview=true");

  // No preview flag at all
  const noFlag = await getPublicFieldNoteBySlug(slug, {
    session: { user: { id: "admin-1", role: "admin" } },
  });
  assert.equal(noFlag, null, "Admin without preview=true must not view draft via public resolver");

  await cleanupFieldNote(slug);
});

test("FN-2: Admin preview exposes draft via shared preview helper", async () => {
  const slug = "fn-admin-preview-" + Date.now();
  const created = await createFieldNote({
    title: "Admin Preview Test",
    slug,
    excerpt: "Testing admin preview authorization",
    author: "Ahmed Awad",
    body: [{ id: "b1", type: "paragraph", text: "Draft secret preview content" }],
  });

  assert.equal(canPreviewAsAdmin(null), false);
  assert.equal(canPreviewAsAdmin({ user: { id: "u", role: "user" } }), false);
  assert.equal(canPreviewAsAdmin({ user: { id: "a", role: "admin" } }), true);

  const adminView = await getPublicFieldNoteBySlug(slug, {
    preview: true,
    session: { user: { id: "admin-1", role: "admin" } },
  });
  assert.notEqual(adminView, null);
  assert.equal(adminView?.id, created.id);
  assert.equal(adminView?.status, "draft");

  await cleanupFieldNote(slug);
});

test("FN-3: Duplicate slug fails safely", async () => {
  const slug = "fn-duplicate-slug-" + Date.now();
  await createFieldNote({ title: "Original Note", slug, author: "Ahmed Awad", body: [] });

  await assert.rejects(
    async () => {
      await createFieldNote({ title: "Conflicting Note", slug, author: "Ahmed Awad", body: [] });
    },
    /already exists/,
    "Creating a field note with an existing slug must fail with an explanatory error"
  );

  await cleanupFieldNote(slug);
});

test("FN-4: Full lifecycle governs public visibility + publishedAt first-publish-wins", async () => {
  const slug = "fn-lifecycle-" + Date.now();
  const note = await createFieldNote({
    title: "Lifecycle Note",
    slug,
    excerpt: "Lifecycle testing",
    author: "Ahmed Awad",
    body: [],
  });
  assert.equal(note.status, "draft");
  assert.equal(note.publishedAt, null);

  // 1. Draft invisible
  assert.equal(await getPublicFieldNoteBySlug(slug), null);

  // 2. Publish -> visible, publishedAt set
  const published = await publishFieldNote(note.id);
  assert.equal(published.status, "published");
  assert.notEqual(published.publishedAt, null);
  const firstPublishedAt = published.publishedAt;
  assert.notEqual(await getPublicFieldNoteBySlug(slug), null);
  assert.ok((await getPublishedFieldNotes()).some((n) => n.id === note.id));

  // 3. Republish preserves original publishedAt (first-publish-wins)
  await unpublishFieldNote(note.id);
  const republished = await publishFieldNote(note.id);
  assert.deepEqual(republished.publishedAt, firstPublishedAt);

  // 4. Unpublish -> invisible
  await unpublishFieldNote(note.id);
  assert.equal((await getPublicFieldNoteBySlug(slug)), null);
  assert.ok(!(await getPublishedFieldNotes()).some((n) => n.id === note.id));

  // 5. Archive -> invisible
  await publishFieldNote(note.id);
  await archiveFieldNote(note.id);
  assert.equal(await getPublicFieldNoteBySlug(slug), null);
  assert.ok(!(await getPublishedFieldNotes()).some((n) => n.id === note.id));

  await cleanupFieldNote(slug);
});

test("FN-5: Revision history records publish + published edits", async () => {
  const slug = "fn-revisions-" + Date.now();
  const note = await createFieldNote({
    title: "Revision Note",
    slug,
    excerpt: "Revision testing",
    author: "Ahmed Awad",
    body: [{ id: "b1", type: "paragraph", text: "v1" }],
  });

  // No revisions for a plain draft
  assert.equal((await getFieldNoteRevisions(note.id)).length, 0);

  // Publish records a revision
  await publishFieldNote(note.id, { createdBy: "admin-1" });
  let revisions = await getFieldNoteRevisions(note.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].trigger, "publish");
  assert.equal(revisions[0].createdBy, "admin-1");

  // Editing while published records an update revision
  await updateFieldNote(
    note.id,
    { id: note.id, title: "Revision Note v2" },
    { createdBy: "admin-1" }
  );
  revisions = await getFieldNoteRevisions(note.id);
  assert.equal(revisions.length, 2);
  const updateRev = revisions.find((r) => r.trigger === "update");
  assert.ok(updateRev, "expected an update revision");
  assert.equal(updateRev.title, "Revision Note v2");

  // Unpublish + archive record their own revisions
  await unpublishFieldNote(note.id);
  await publishFieldNote(note.id);
  await archiveFieldNote(note.id);
  revisions = await getFieldNoteRevisions(note.id);
  const triggers = revisions.map((r) => r.trigger);
  assert.ok(triggers.includes("unpublish"));
  assert.ok(triggers.includes("archive"));

  await cleanupFieldNote(slug);
});

test("FN-6: Draft edit does not touch publishedAt and records no revision", async () => {
  const slug = "fn-draft-edit-" + Date.now();
  const note = await createFieldNote({
    title: "Draft Edit Note",
    slug,
    author: "Ahmed Awad",
    body: [{ id: "b1", type: "paragraph", text: "draft" }],
  });

  const updated = await updateFieldNote(note.id, { id: note.id, title: "Draft Edit Note v2" });
  assert.equal(updated.publishedAt, null);
  assert.equal((await getFieldNoteRevisions(note.id)).length, 0);

  await cleanupFieldNote(slug);
});

test("FN-7: Shared URL validator + reading-time helper behave for field notes", async () => {
  assert.equal(isSafeUrl("javascript:alert(1)"), false);
  assert.equal(isSafeUrl("/field-notes/some-note"), true);
  assert.equal(isSafeUrl("https://decodedhiring.com/field-notes"), true);

  assert.equal(estimateReadingTime([]), 1);
  const minutes = estimateReadingTime([
    { id: "a", type: "paragraph", text: "word ".repeat(400).trim() },
    { id: "b", type: "callout", tone: "note", label: "NOTE", text: "short" },
  ]);
  assert.ok(minutes >= 2, `expected >= 2 min for 400+ words, got ${minutes}`);
});

test("FN-8: Media boundary reuses same rules with field-notes namespace", async () => {
  await assert.rejects(
    async () => {
      await uploadMedia({
        buffer: new Uint8Array([1, 2, 3]),
        filename: "evil.exe",
        contentType: "application/x-msdownload",
        namespace: "field-notes",
      });
    },
    /Unsupported media type/
  );

  const result = await uploadMedia({
    buffer: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    filename: "note-cover.png",
    contentType: "image/png",
    namespace: "field-notes",
    uploadedBy: "admin-test",
  });
  assert.ok(result.key.startsWith("field-notes/"));
  assert.ok(result.url.startsWith("/api/media/field-notes/"));
});

test("FN-9: Archived is terminal — republish/unpublish/re-archive rejected, public 404", async () => {
  const slug = "fn-archived-terminal-" + Date.now();
  const note = await createFieldNote({
    title: "Archived Terminal Note",
    slug,
    author: "Ahmed Awad",
    body: [{ id: "b1", type: "paragraph", text: "terminal" }],
  });

  await publishFieldNote(note.id);
  const archived = await archiveFieldNote(note.id);
  assert.equal(archived.status, "archived");

  await assert.rejects(
    () => publishFieldNote(note.id),
    /archived/i,
    "Republishing an archived note must fail"
  );
  await assert.rejects(
    () => unpublishFieldNote(note.id),
    /archived/i,
    "Unpublishing an archived note must fail"
  );
  await assert.rejects(
    () => archiveFieldNote(note.id),
    /archived/i,
    "Re-archiving an archived note must fail"
  );

  // State unchanged + still invisible publicly
  const still = await getPublicFieldNoteBySlug(slug);
  assert.equal(still, null, "Archived note must stay publicly invisible");
  assert.ok(!(await getPublishedFieldNotes()).some((n) => n.id === note.id));

  await cleanupFieldNote(slug);
});

test("FN-10: Repeated transitions rejected; draft->archive allowed; guard unit matrix", async () => {
  // Pure guard matrix (no DB)
  assert.doesNotThrow(() => assertFieldNoteTransition("draft", "publish"));
  assert.doesNotThrow(() => assertFieldNoteTransition("draft", "archive"));
  assert.doesNotThrow(() => assertFieldNoteTransition("published", "unpublish"));
  assert.doesNotThrow(() => assertFieldNoteTransition("published", "archive"));
  assert.throws(() => assertFieldNoteTransition("published", "publish"), /"published"/);
  assert.throws(() => assertFieldNoteTransition("draft", "unpublish"), /"draft"/);
  assert.throws(() => assertFieldNoteTransition("archived", "publish"), /archived/i);
  assert.throws(() => assertFieldNoteTransition("archived", "unpublish"), /archived/i);
  assert.throws(() => assertFieldNoteTransition("archived", "archive"), /archived/i);

  // Service-level: meaningless repeats rejected
  const slugA = "fn-repeat-guard-" + Date.now();
  const draft = await createFieldNote({ title: "Repeat Guard", slug: slugA, author: "Ahmed Awad", body: [] });
  await assert.rejects(() => unpublishFieldNote(draft.id), /"draft"/, "Unpublishing a draft must fail");
  await publishFieldNote(draft.id);
  await assert.rejects(() => publishFieldNote(draft.id), /"published"/, "Re-publishing a published note must fail");

  // Service-level: draft -> archived is a valid direct transition
  const slugB = "fn-direct-archive-" + Date.now();
  const draftB = await createFieldNote({ title: "Direct Archive", slug: slugB, author: "Ahmed Awad", body: [] });
  const archivedB = await archiveFieldNote(draftB.id);
  assert.equal(archivedB.status, "archived");

  await cleanupFieldNote(slugA);
  await cleanupFieldNote(slugB);
});

test("FN-11: Narrow media URL boundary accepts safe covers, rejects unsafe schemes", () => {
  // Accepted: approved local namespace + https externals
  for (const good of [
    "/api/media/field-notes/cover-abc123.png",
    "/api/media/guides/cover.jpg",
    "https://cdn.decodedhiring.com/covers/note.webp",
    "https://decodedhiring.com/c.png",
    "HTTPS://EXAMPLE.COM/UPPER.PNG",
  ]) {
    assert.equal(isSafeMediaUrl(good), true, `expected ACCEPT: ${good}`);
  }

  // Rejected: dangerous schemes, protocol-relative, http, non-media paths, malformed
  const bad: Array<string | null | undefined> = [
    null,
    undefined,
    "",
    "   ",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:image/png;base64,iVBORw0KGgo=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "mailto:ahmed@decodedhiring.com",
    "tel:+15551234567",
    "ftp://example.com/cover.png",
    "http://example.com/cover.png",
    "http://localhost:3000/api/media/x.png",
    "//example.com/cover.png",
    "/field-notes/some-note",
    "/api/media/",
    "/api/media/has space.png",
    "not a url",
    "https://",
  ];
  for (const url of bad) {
    assert.equal(isSafeMediaUrl(url), false, `expected REJECT: ${String(url)}`);
  }
});

test("FN-12: coverImage schemas enforce the media boundary without breaking valid behavior", () => {
  const base = {
    title: "Schema Cover Check",
    slug: "schema-cover-check",
    author: "Ahmed Awad",
    body: [],
  };

  // Valid: omitted / null / approved local / https external
  assert.equal(createFieldNoteSchema.safeParse({ ...base }).success, true);
  assert.equal(createFieldNoteSchema.safeParse({ ...base, coverImage: null }).success, true);
  assert.equal(
    createFieldNoteSchema.safeParse({ ...base, coverImage: "/api/media/field-notes/c.png" }).success,
    true
  );
  assert.equal(
    createFieldNoteSchema.safeParse({ ...base, coverImage: "https://cdn.example.com/c.png" }).success,
    true
  );

  // Invalid: dangerous scheme, protocol-relative, http, non-media relative path
  for (const coverImage of [
    "javascript:alert(1)",
    "data:image/png;base64,xxx",
    "//cdn.example.com/c.png",
    "http://example.com/c.png",
    "/guides/some-guide",
  ]) {
    const res = createFieldNoteSchema.safeParse({ ...base, coverImage });
    assert.equal(res.success, false, `field-note schema must reject: ${coverImage}`);
  }

  // Guides reuse the same boundary with identical outcomes
  assert.equal(
    createGuideSchema.safeParse({ ...base, coverImage: "/api/media/guides/c.png" }).success,
    true
  );
  assert.equal(
    createGuideSchema.safeParse({ ...base, coverImage: "https://cdn.example.com/c.png" }).success,
    true
  );
  const guideBad = createGuideSchema.safeParse({ ...base, coverImage: "javascript:alert(1)" });
  assert.equal(guideBad.success, false, "guide schema must reject javascript: covers");
});
