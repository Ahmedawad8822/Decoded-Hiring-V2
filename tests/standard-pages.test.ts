/**
 * STANDARD PAGES (§3 + lifecycle §1)
 * ---------------------------------------------------------------------------
 * CRUD + validation (reserved slugs, uniqueness), full §1 lifecycle
 * (publish/unpublish/archive/restore/trash/restore/permanent delete/purge),
 * public visibility rules, noindex sitemap exclusion, slug redirects,
 * admin-only actions and the admin audit trail. Real D1 (local Miniflare),
 * no mocks — the auth gate is driven through real server actions with a
 * signed-in admin session (next/headers + next/cache stubbed, as in
 * tests/admin-audit-trail.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
// These admins have no 2FA enrolled; the 2FA gate itself is covered by
// tests/admin-two-factor.test.ts.
process.env.ADMIN_REQUIRE_2FA = "false";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { adminAuditLog, getDb, guides, media, pageRevisions, pages, users } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import { markEmailVerified } from "./helpers/verified";
import {
  archivePage,
  createPage,
  deletePagePermanently,
  getAdminPageById,
  getAllAdminPages,
  getPublicPageBySlug,
  getSitemapPages,
  listTrashedPages,
  movePageToTrash,
  publishPage,
  purgeExpiredPages,
  restorePageFromArchive,
  restorePageFromTrash,
  unpublishPage,
  updatePage,
} from "../src/features/pages/service";
import { createPageSchema } from "../src/features/pages/types";
import { isReservedPageSlug, RESERVED_PAGE_SLUGS, buildPagePreviewRewriteSource, buildReservedSlugExclusionPattern, PAGE_PREVIEW_REWRITE_EXCLUSIONS } from "../src/features/pages/reserved-slugs";
import { resolvePageRedirect } from "../src/features/slug-redirects/service";
import { buildSitemapEntries } from "../src/lib/sitemap-entries";

const nodeRequire = createRequire(__filename);
let cookieHeader = "";
const revalidatedPaths: string[] = [];

/** Install stubs in require.cache BEFORE the app modules that import them load. */
function stubModule(id: string, exports: Record<string, unknown>) {
  const resolved = nodeRequire.resolve(id);
  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

const uid = () => crypto.randomUUID().slice(0, 8);
let adminId = "";

type Mods = {
  actions: typeof import("../src/features/pages/actions");
};
let m: Mods;

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", {
    revalidatePath: (path: string) => { revalidatedPaths.push(path); },
    revalidateTag: () => {},
    unstable_cache: <T>(fn: T) => fn,
  });

  const auth = await getAuth();
  const email = `pages-admin-${uid()}@example.com`;
  const password = "PagesAdminPass123!";
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Pages Admin" } });
  adminId = created.user.id;
  const db = await getDb();
  await db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
  await markEmailVerified(created.user.id);
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  cookieHeader = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookieHeader, "sign-in must yield a session cookie");

  m = { actions: await import("../src/features/pages/actions") };
});

test.after(async () => {
  await disposeCloudflareBindings();
});

async function cleanupPage(slug: string) {
  const db = await getDb();
  const row = await db.select().from(pages).where(eq(pages.slug, slug)).get();
  if (row) {
    await db.delete(pageRevisions).where(eq(pageRevisions.pageId, row.id));
    await db.delete(pages).where(eq(pages.id, row.id));
  }
}

test("SP-1: reserved slugs are rejected by validation", () => {
  for (const slug of ["about", "guides", "admin", "learn", "go", "login"]) {
    assert.equal(isReservedPageSlug(slug), true, `${slug} must be reserved`);
    const parsed = createPageSchema.safeParse({ title: "Some Page", slug, body: [] });
    assert.equal(parsed.success, false, `schema must reject reserved slug "${slug}"`);
  }
  assert.ok(RESERVED_PAGE_SLUGS.length > 10, "reserved list covers routes + top-level segments");
  const ok = createPageSchema.safeParse({ title: "Some Page", slug: `fine-${uid()}`, body: [] });
  assert.equal(ok.success, true);
});

test("SP-2: duplicate slugs fail safely", async () => {
  const slug = `sp-dup-${uid()}`;
  await createPage({ title: "Original Page", slug, body: [] });
  await assert.rejects(() => createPage({ title: "Clashing Page", slug, body: [] }), /already exists/);
  await cleanupPage(slug);
});

test("SP-3: full lifecycle publish/unpublish/archive/restore governs visibility", async () => {
  const slug = `sp-life-${uid()}`;
  const page = await createPage({ title: "Lifecycle Page", slug, body: [] });
  assert.equal(page.status, "draft");

  assert.equal(await getPublicPageBySlug(slug), null, "draft is not public");

  const published = await publishPage(page.id);
  assert.equal(published.status, "published");
  assert.ok(published.publishedAt instanceof Date);
  const firstPublishedAt = published.publishedAt!.getTime();

  const visible = await getPublicPageBySlug(slug);
  assert.notEqual(visible, null);

  const unpublished = await unpublishPage(page.id);
  assert.equal(unpublished.status, "draft");
  assert.equal(await getPublicPageBySlug(slug), null);

  // Republish keeps the first publishedAt (first-publish-wins).
  const republished = await publishPage(page.id);
  assert.equal(republished.publishedAt!.getTime(), firstPublishedAt);

  const archived = await archivePage(page.id);
  assert.equal(archived.status, "archived");
  assert.equal(await getPublicPageBySlug(slug), null, "archived is not public");

  // §1 restore: archived -> draft, never straight to published.
  const restored = await restorePageFromArchive(page.id);
  assert.equal(restored.status, "draft");
  assert.equal(await getPublicPageBySlug(slug), null);

  await assert.rejects(() => publishPage(page.id).then(() => restorePageFromArchive(page.id)), /Only an archived page/);

  await cleanupPage(slug);
});

test("SP-4: admin preview exposes drafts, anonymous/learner preview does not", async () => {
  const slug = `sp-prev-${uid()}`;
  await createPage({ title: "Preview Page", slug, body: [] });

  const anon = await getPublicPageBySlug(slug, { preview: true, session: null });
  assert.equal(anon, null);

  const learner = await getPublicPageBySlug(slug, {
    preview: true,
    session: { user: { id: "u", role: "user" } },
  });
  assert.equal(learner, null);

  const admin = await getPublicPageBySlug(slug, {
    preview: true,
    session: { user: { id: "a", role: "admin" } },
  });
  assert.notEqual(admin, null);

  await cleanupPage(slug);
});

test("SP-5: trash hides everywhere, restore returns the previous state", async () => {
  const slug = `sp-trash-${uid()}`;
  const page = await createPage({ title: "Trash Page", slug, body: [] });
  await archivePage(page.id);

  // Published pages must be unpublished/archived first.
  const slug2 = `sp-trash-pub-${uid()}`;
  const pub = await createPage({ title: "Published Trash Page", slug: slug2, body: [] });
  await publishPage(pub.id);
  await assert.rejects(() => movePageToTrash(pub.id), /Unpublish or archive/);

  const trashed = await movePageToTrash(page.id);
  assert.ok(trashed.trashedAt instanceof Date);
  assert.equal(trashed.trashedFromStatus, "archived");

  // Hidden from the normal Studio list and from public/learner views.
  assert.equal((await getAllAdminPages()).some((p) => p.id === page.id), false);
  assert.equal(await getPublicPageBySlug(slug, { preview: true, session: { user: { id: "a", role: "admin" } } }), null);

  const listed = await listTrashedPages();
  assert.ok(listed.some((p) => p.id === page.id), "trash registry lists the page");

  // Slug stays reserved while trashed.
  await assert.rejects(() => createPage({ title: "Reuse", slug, body: [] }), /already exists/);

  const restored = await restorePageFromTrash(page.id, adminId);
  assert.equal(restored.trashedAt, null);
  assert.equal(restored.status, "archived");
  assert.ok((await getAllAdminPages()).some((p) => p.id === page.id));

  await cleanupPage(slug);
  await archivePage(pub.id);
  await movePageToTrash(pub.id);
  await deletePagePermanently(pub.id, adminId, "Published Trash Page");
});

test("SP-6: permanent delete needs trashed state + exact title, then frees the slug", async () => {
  const slug = `sp-del-${uid()}`;
  const page = await createPage({ title: "Delete Me", slug, body: [] });

  await assert.rejects(
    () => deletePagePermanently(page.id, adminId, "Delete Me"),
    /Move the page to Trash first/
  );

  await movePageToTrash(page.id);
  await assert.rejects(
    () => deletePagePermanently(page.id, adminId, "Wrong Title"),
    /confirmation title does not match/
  );

  const snapshot = await deletePagePermanently(page.id, adminId, "Delete Me");
  assert.deepEqual(snapshot, { id: page.id, title: "Delete Me", slug });
  assert.equal(await getAdminPageById(page.id), null, "row is gone");
  assert.deepEqual(await listTrashedPages().then((rows) => rows.filter((r) => r.id === page.id)), []);

  // Slug is free again after permanent delete.
  const reused = await createPage({ title: "Reuse", slug, body: [] });
  assert.equal(reused.slug, slug);
  await cleanupPage(slug);
});

test("SP-7: purge removes only pages trashed for more than 30 days", async () => {
  const oldSlug = `sp-purge-old-${uid()}`;
  const freshSlug = `sp-purge-fresh-${uid()}`;
  const oldPage = await createPage({ title: "Old Trash", slug: oldSlug, body: [] });
  const freshPage = await createPage({ title: "Fresh Trash", slug: freshSlug, body: [] });
  await movePageToTrash(oldPage.id);
  await movePageToTrash(freshPage.id);

  const db = await getDb();
  await db
    .update(pages)
    .set({ trashedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
    .where(eq(pages.id, oldPage.id));

  const result = await purgeExpiredPages(new Date(), 10);
  assert.ok(result.purged.includes(oldPage.id), "expired page purged");
  assert.equal(result.kept.length, 0);
  assert.equal(await getAdminPageById(oldPage.id), null);
  assert.notEqual(await getAdminPageById(freshPage.id), null, "fresh trash stays");

  await deletePagePermanently(freshPage.id, adminId, "Fresh Trash");
});

test("SP-8: renaming a published page records a redirect to the new URL", async () => {
  const a = `sp-rd-a-${uid()}`;
  const b = `sp-rd-b-${uid()}`;
  const page = await createPage({ title: "Redirect Page", slug: a, body: [] });
  await publishPage(page.id);
  await updatePage(page.id, { id: page.id, slug: b });
  assert.equal(await resolvePageRedirect(a), `/${b}`);
  assert.equal(await resolvePageRedirect(b), null, "current slug is not a redirect");
  // Trashed pages never resolve.
  await unpublishPage(page.id);
  await archivePage(page.id);
  await movePageToTrash(page.id);
  assert.equal(await resolvePageRedirect(a), null, "trashed pages do not redirect");
  await restorePageFromTrash(page.id, adminId);
  await restorePageFromArchive(page.id);
  await publishPage(page.id);
  assert.equal(await resolvePageRedirect(a), `/${b}`, "redirect works again once published");
  await unpublishPage(page.id);
  await archivePage(page.id);
  await movePageToTrash(page.id);
  await deletePagePermanently(page.id, adminId, "Redirect Page");
  assert.equal(await resolvePageRedirect(a), null, "redirects die with the page");
});

test("SP-9: sitemap includes published pages, excludes noindex/draft", async () => {
  const live = `sp-map-live-${uid()}`;
  const hidden = `sp-map-hidden-${uid()}`;
  const draft = `sp-map-draft-${uid()}`;
  const livePage = await createPage({ title: "Live Page", slug: live, body: [] });
  const hiddenPage = await createPage({ title: "Hidden Page", slug: hidden, noindex: true, body: [] });
  await createPage({ title: "Draft Page", slug: draft, body: [] });
  await publishPage(livePage.id);
  await publishPage(hiddenPage.id);

  assert.ok((await getSitemapPages()).some((p) => p.slug === live));
  assert.equal((await getSitemapPages()).some((p) => p.slug === hidden), false, "noindex excluded");

  const entries = await buildSitemapEntries();
  const urls = entries.map((e) => e.url);
  assert.ok(urls.some((u) => u.endsWith(`/${live}`)), "sitemap includes the page");
  assert.equal(urls.some((u) => u.endsWith(`/${hidden}`)), false, "sitemap excludes noindex");
  assert.equal(urls.some((u) => u.endsWith(`/${draft}`)), false, "sitemap excludes drafts");

  await unpublishPage(livePage.id);
  await archivePage(livePage.id);
  await movePageToTrash(livePage.id);
  await deletePagePermanently(livePage.id, adminId, "Live Page");
  await unpublishPage(hiddenPage.id);
  await archivePage(hiddenPage.id);
  await movePageToTrash(hiddenPage.id);
  await deletePagePermanently(hiddenPage.id, adminId, "Hidden Page");
  await cleanupPage(draft);
});

test("SP-11: anonymous action calls fail; admin actions succeed and audit", async () => {
  cookieHeader = "";
  const denied = await m.actions.createPageAction({ title: "Nope", slug: `sp-deny-${uid()}`, body: [] });
  assert.equal(denied.ok, false, "signed-out create must fail");

  // Restore the admin session for the remaining action calls.
  const auth = await getAuth();
  const signIn = await auth.api.signInEmail({
    body: { email: (await (await getDb()).select().from(users).where(eq(users.id, adminId)).get())!.email, password: "PagesAdminPass123!" },
    returnHeaders: true,
  });
  cookieHeader = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const slug = `sp-act-${uid()}`;
  const created = await m.actions.createPageAction({ title: "Action Page", slug, body: [] });
  assert.equal(created.ok, true, `admin create must succeed: ${!created.ok ? created.error : ""}`);
  const id = created.ok ? created.data.id : "";

  const bad = await m.actions.createPageAction({ title: "Action Page", slug, body: [] });
  assert.equal(bad.ok, false, "duplicate slug fails with a friendly error");

  const reserved = await m.actions.createPageAction({ title: "About Clone", slug: "about", body: [] });
  assert.equal(reserved.ok, false, "reserved slug fails validation");

  const published = await m.actions.publishPageAction(id);
  assert.equal(published.ok, true);
  assert.ok(revalidatedPaths.includes(`/${slug}`), "public path revalidated");
  assert.ok(revalidatedPaths.includes("/sitemap.xml"), "sitemap revalidated");

  const archived = await m.actions.archivePageAction(id);
  assert.equal(archived.ok, true);

  const restored = await m.actions.restorePageAction(id);
  assert.equal(restored.ok, true);

  const trashed = await m.actions.trashPageAction(id);
  assert.equal(trashed.ok, true);

  const restoredTrash = await m.actions.restorePageFromTrashAction(id);
  assert.equal(restoredTrash.ok, true);

  const db = await getDb();
  const audit = await db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.entityId, id));
  const actions = audit.map((row) => row.action).sort();
  for (const expected of ["page.archive", "page.create", "page.publish", "page.restore", "page.restore_trash", "page.trash"]) {
    assert.ok(actions.includes(expected), `audit must include ${expected} (got ${actions.join(", ")})`);
  }
  assert.ok(audit.every((row) => row.entityType === "page"));

  const wrongTitle = await m.actions.deletePagePermanentlyAction({ id, confirmTitle: "Nope" });
  assert.equal(wrongTitle.ok, false, "wrong confirmation title fails");
  const deleted = await m.actions.deletePagePermanentlyAction({ id, confirmTitle: "Action Page" });
  // Not trashed right now (restored above) — must fail first...
  assert.equal(deleted.ok, false);
  await m.actions.archivePageAction(id);
  await m.actions.trashPageAction(id);
  const deletedForReal = await m.actions.deletePagePermanentlyAction({ id, confirmTitle: "Action Page" });
  assert.equal(deletedForReal.ok, true);
  const auditAfter = await db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, id));
  assert.ok(auditAfter.some((row) => row.action === "page.delete_permanent"));
  assert.ok(
    (auditAfter.find((row) => row.action === "page.delete_permanent")?.details ?? "").includes("Action Page"),
    "permanent-delete audit keeps a title snapshot"
  );
});

test("SP-12: permanent delete keeps media referenced by other bodies, cleans up orphans", async () => {
  const db = await getDb();
  const tag = uid();
  const keyShared = `pages/sp12-${tag}-shared.webp`;
  const keyBodyOnly = `pages/sp12-${tag}-bodyonly.webp`;
  const keyCoverOnly = `pages/sp12-${tag}-coveronly.webp`;
  const urlShared = `/api/media/${keyShared}`;
  const urlBodyOnly = `/api/media/${keyBodyOnly}`;
  const urlCoverOnly = `/api/media/${keyCoverOnly}`;

  for (const key of [keyShared, keyBodyOnly, keyCoverOnly]) {
    await db.insert(media).values({
      id: crypto.randomUUID(),
      key,
      filename: "test.webp",
      contentType: "image/webp",
      size: 10,
      uploadedBy: adminId,
      createdAt: new Date(),
    });
  }
  const mediaExists = async (key: string) =>
    (await db.select().from(media).where(eq(media.key, key)).get()) !== undefined;

  // Page A carries the shared key as its cover; page B reuses it in body text.
  const pageA = await createPage({ title: `Shared Cover ${tag}`, slug: `sp-share-a-${tag}`, coverImage: urlShared, body: [] });
  const pageB = await createPage({
    title: `Sharing Body ${tag}`,
    slug: `sp-share-b-${tag}`,
    body: [{ id: "b1", type: "paragraph", text: `See [photo](${urlShared}) here` }],
  });
  // A guide body references the same object too.
  const guideId = `guide_sp12_${tag}`;
  await db.insert(guides).values({
    id: guideId,
    title: `Sharing Guide ${tag}`,
    slug: `sp12-guide-${tag}`,
    body: JSON.stringify([{ id: "g1", type: "paragraph", text: `Guide [photo](${urlShared}) here` }]),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // Page C holds a body-only key nobody else references; page D a cover-only key.
  const pageC = await createPage({
    title: `Body Only ${tag}`,
    slug: `sp-bodyonly-${tag}`,
    body: [{ id: "c1", type: "paragraph", text: `Only [here](${urlBodyOnly})` }],
  });
  const pageD = await createPage({ title: `Cover Only ${tag}`, slug: `sp-coveronly-${tag}`, coverImage: urlCoverOnly, body: [] });

  await movePageToTrash(pageA.id);
  await deletePagePermanently(pageA.id, adminId, `Shared Cover ${tag}`);
  assert.equal(await mediaExists(keyShared), true, "shared object survives: page B body + guide body still reference it");

  await movePageToTrash(pageC.id);
  await deletePagePermanently(pageC.id, adminId, `Body Only ${tag}`);
  assert.equal(await mediaExists(keyBodyOnly), false, "body-only orphan is cleaned up");

  await movePageToTrash(pageD.id);
  await deletePagePermanently(pageD.id, adminId, `Cover Only ${tag}`);
  assert.equal(await mediaExists(keyCoverOnly), false, "unreferenced cover is cleaned up");

  // Cleanup: drop the guide reference, then page B deletes cleanly (and takes
  // the now-unreferenced shared object with it).
  await db.delete(guides).where(eq(guides.id, guideId));
  await movePageToTrash(pageB.id);
  await deletePagePermanently(pageB.id, adminId, `Sharing Body ${tag}`);
  assert.equal(await mediaExists(keyShared), false, "last reference gone, object cleaned up");
});

test("SP-13: the ?preview=true page rewrite excludes every reserved top-level route", async () => {
  const nextConfig = (await import("../next.config")).default as {
    rewrites: () => Promise<{ beforeFiles: { source: string; destination: string }[] }>;
  };
  const rewrites = await nextConfig.rewrites();
  const entry = rewrites.beforeFiles.find((r) => r.destination === "/preview/pages/:slug");
  assert.ok(entry, "page preview rewrite is wired in next.config.ts");
  assert.equal(entry.source, buildPagePreviewRewriteSource(), "rewrite source comes from reserved-slugs (single source of truth)");

  // Simulate Next's single-segment match against the wired source.
  const match = entry.source.match(/^\/:slug\((.*)\)$/);
  assert.ok(match?.[1], "source carries a :slug(...) regex");
  const segment = new RegExp(`^(?:${match[1]})$`);

  for (const slug of PAGE_PREVIEW_REWRITE_EXCLUSIONS) {
    assert.equal(segment.test(slug), false, `reserved segment "${slug}" must not rewrite`);
  }
  for (const slug of RESERVED_PAGE_SLUGS) {
    assert.equal(segment.test(slug), false, `reserved slug "${slug}" must not rewrite`);
  }
  for (const slug of ["admin", "api", "learn", "login", "signup", "sitemap.xml", "robots.txt"]) {
    assert.equal(segment.test(slug), false, `"${slug}" must not rewrite to the page preview`);
  }
  for (const slug of ["pricing-faq", "about-us", "administrator", "learning", "press"]) {
    assert.equal(segment.test(slug), true, `"${slug}" is a genuine page slug and must still rewrite`);
  }
  // The exclusion pattern itself derives from the reserved list.
  assert.ok(buildReservedSlugExclusionPattern().length > 0);
});
