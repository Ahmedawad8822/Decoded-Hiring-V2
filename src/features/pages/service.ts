import {
  fieldNotes,
  getDb,
  guides,
  media,
  pageRevisions,
  pages,
  slugRedirects,
  type Page,
  type PageRevision,
  type PageRevisionTrigger,
} from "@/lib/db";
import { and, asc, desc, eq, isNotNull, isNull, lt, ne } from "drizzle-orm";
import type { CreatePageInput, UpdatePageInput } from "./types";
import { resolvePreviewAccess } from "@/features/publishing/preview";
import {
  buildArchiveUpdate,
  buildEditTouch,
  buildPublishUpdate,
  buildUnpublishUpdate,
} from "@/features/publishing/lifecycle";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AppError } from "@/lib/errors";
import {
  buildReleaseSlugStatement,
  buildSlugChangeStatements,
} from "@/features/slug-redirects/service";
import { getR2Bucket } from "@/lib/cloudflare/bindings";

// ============================================================================
// STANDARD PAGE SERVICE (§3, lifecycle §1)
// ----------------------------------------------------------------------------
// Explicit per-domain data access (no generic repositories). Lifecycle and
// preview rules come from the shared publishing primitives; §1 Trash is
// implemented here because Guides/Field Notes still treat archived as
// terminal — Pages are the first type with the full lifecycle:
//   draft -> published -> archived -> draft (restore)
//   draft|archived -> trashed -> draft|archived (restore) -> deleted
// Published rows must be unpublished/archived before they can be trashed.
// Trashed rows are hidden from every normal Studio list and every public
// view; their slugs stay reserved until permanent delete.
// Revision history mirrors Field Notes (cheap): a snapshot is recorded on
// publish and on every update applied while published, plus
// unpublish/archive/restore — so the history shows what actually went live.
// ============================================================================

export type PageTransition = "publish" | "unpublish" | "archive" | "restore";

const PAGE_TRANSITIONS: Record<Page["status"], PageTransition[]> = {
  draft: ["publish", "archive"],
  published: ["unpublish", "archive"],
  // Archived is editable again only via restore (back to draft, never
  // straight to published) — §1.
  archived: ["restore"],
};

function assertPageTransition(from: Page["status"], action: PageTransition): void {
  const allowed = PAGE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(action)) {
    if (action === "restore") {
      throw new AppError(
        "invalid",
        `Only an archived page can be restored to draft (current status "${from}").`
      );
    }
    if (from === "archived") {
      throw new AppError(
        "invalid",
        `Cannot ${action} an archived page. Restore it to draft first.`
      );
    }
    throw new AppError("invalid", `Cannot ${action} a page with status "${from}".`);
  }
}

function buildRestoreUpdate(now: Date): { status: "draft"; updatedAt: Date } {
  return { status: "draft", updatedAt: now };
}

/// Only non-trashed rows are visible to normal reads.
function alive() {
  return isNull(pages.trashedAt);
}

export async function getPublishedPages(): Promise<Page[]> {
  const db = await getDb();
  return db
    .select()
    .from(pages)
    .where(and(eq(pages.status, "published"), alive()))
    .orderBy(desc(pages.publishedAt), desc(pages.updatedAt));
}

/// Pages for the sitemap: published, non-trashed, and indexable.
export async function getSitemapPages(): Promise<Page[]> {
  const db = await getDb();
  return db
    .select()
    .from(pages)
    .where(and(eq(pages.status, "published"), eq(pages.noindex, false), alive()))
    .orderBy(asc(pages.slug));
}

export async function getPublicPageBySlug(
  slug: string,
  options?: { preview?: boolean; session?: { user?: { id?: string; role?: string | null } } | null }
): Promise<Page | null> {
  const db = await getDb();
  const page = await db.select().from(pages).where(eq(pages.slug, slug)).get();

  if (!page) {
    return null;
  }

  // Trashed pages are hidden from every public view, with no preview.
  if (page.trashedAt !== null) {
    return null;
  }

  // 1. Published pages are always visible
  if (page.status === "published") {
    return page;
  }

  // 2. Draft / Archived pages only with ?preview=true + admin session
  if (resolvePreviewAccess({ preview: options?.preview, session: options?.session })) {
    return page;
  }

  // 3. Otherwise 404
  return null;
}

export async function getAllAdminPages(): Promise<Page[]> {
  const db = await getDb();
  return db.select().from(pages).where(alive()).orderBy(desc(pages.updatedAt));
}

export async function getAdminPageById(id: string): Promise<Page | null> {
  const db = await getDb();
  const page = await db.select().from(pages).where(eq(pages.id, id)).get();
  return page || null;
}

/// Trash registry shape for the shared Studio Trash page (wired by the
/// coordinator): one row per trashed page with days left before auto-purge.
export async function listTrashedPages(): Promise<Page[]> {
  const db = await getDb();
  return db
    .select()
    .from(pages)
    .where(isNotNull(pages.trashedAt))
    .orderBy(desc(pages.trashedAt));
}

export async function getPageRevisions(pageId: string): Promise<PageRevision[]> {
  const db = await getDb();
  return db
    .select()
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, pageId))
    .orderBy(desc(pageRevisions.createdAt));
}

async function recordRevision(
  page: Page,
  trigger: PageRevisionTrigger,
  createdBy?: string | null
): Promise<void> {
  const db = await getDb();
  await db.insert(pageRevisions).values({
    id: `pgrev_${crypto.randomUUID().slice(0, 12)}`,
    pageId: page.id,
    title: page.title,
    body: page.body,
    status: page.status,
    trigger,
    createdBy: createdBy || null,
    createdAt: new Date(),
  });
}

function conflictError(slug: string): AppError {
  return new AppError(
    "conflict",
    `A page with the slug "${slug}" already exists. Please choose a unique slug.`
  );
}

export async function createPage(input: CreatePageInput): Promise<Page> {
  const db = await getDb();

  // Enforce slug uniqueness at domain level (reserved slugs are rejected
  // earlier by the zod schema on both create and rename).
  const existing = await db.select().from(pages).where(eq(pages.slug, input.slug)).get();
  if (existing) {
    throw conflictError(input.slug);
  }

  const now = new Date();
  const id = `page_${crypto.randomUUID().slice(0, 12)}`;

  try {
    // A new live page wins over any redirect that used this slug.
    await db.batch([
      buildReleaseSlugStatement(db, { entityType: "page", scope: "", slug: input.slug }),
      db.insert(pages).values({
        id,
        title: input.title,
        slug: input.slug,
        summary: input.summary || null,
        body: JSON.stringify(input.body || []),
        coverImage: input.coverImage || null,
        status: "draft",
        metaTitle: input.metaTitle || input.title,
        metaDescription: input.metaDescription || input.summary || null,
        noindex: input.noindex ?? false,
        trashedAt: null,
        trashedFromStatus: null,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
      }),
    ]);
  } catch (error: unknown) {
    // The pages.slug UNIQUE index is the authoritative concurrency backstop.
    if (!isUniqueConstraintError(error)) throw error;
    const conflict = await db.select().from(pages).where(eq(pages.slug, input.slug)).get();
    if (!conflict) throw error;
    throw conflictError(input.slug);
  }

  const created = await getAdminPageById(id);
  if (!created) {
    throw new Error("Failed to retrieve created page");
  }
  return created;
}

export async function updatePage(
  id: string,
  input: UpdatePageInput,
  options?: { createdBy?: string | null }
): Promise<Page> {
  const db = await getDb();
  const current = await getAdminPageById(id);
  if (!current) {
    throw new AppError("not_found", `Page with id "${id}" not found`);
  }
  if (current.trashedAt !== null) {
    throw new AppError("invalid", "Trashed pages cannot be edited. Restore the page first.");
  }

  // Check slug uniqueness if slug is being modified
  if (input.slug && input.slug !== current.slug) {
    const existing = await db
      .select()
      .from(pages)
      .where(and(eq(pages.slug, input.slug), ne(pages.id, id)))
      .get();
    if (existing) {
      throw conflictError(input.slug);
    }
  }

  const now = new Date();
  const updateData: Partial<typeof pages.$inferInsert> = {
    ...buildEditTouch(now),
  };

  if (typeof input.title !== "undefined") updateData.title = input.title;
  if (typeof input.slug !== "undefined") updateData.slug = input.slug;
  if (typeof input.summary !== "undefined") updateData.summary = input.summary || null;
  if (typeof input.body !== "undefined") updateData.body = JSON.stringify(input.body);
  if (typeof input.coverImage !== "undefined") updateData.coverImage = input.coverImage;
  if (typeof input.metaTitle !== "undefined") updateData.metaTitle = input.metaTitle;
  if (typeof input.metaDescription !== "undefined") updateData.metaDescription = input.metaDescription;
  if (typeof input.noindex !== "undefined") updateData.noindex = input.noindex;

  try {
    // Same batch (one D1 transaction): the UPDATE plus the old-slug redirect.
    await db.batch([
      db.update(pages).set(updateData).where(eq(pages.id, id)),
      ...buildSlugChangeStatements(db, {
        entityType: "page",
        entityId: id,
        oldSlug: current.slug,
        newSlug: updateData.slug ?? current.slug,
        everPublished: current.publishedAt !== null,
        now,
      }),
    ]);
  } catch (error: unknown) {
    if (!isUniqueConstraintError(error)) throw error;
    const conflict = await db
      .select()
      .from(pages)
      .where(and(eq(pages.slug, updateData.slug ?? input.slug ?? current.slug), ne(pages.id, id)))
      .get();
    if (!conflict) throw error;
    throw conflictError(input.slug ?? current.slug);
  }

  const updated = await getAdminPageById(id);
  if (!updated) {
    throw new Error("Failed to retrieve updated page");
  }

  // Preserve edit history for published content
  if (current.status === "published") {
    await recordRevision(updated, "update", options?.createdBy);
  }

  return updated;
}

export async function publishPage(
  id: string,
  options?: { createdBy?: string | null }
): Promise<Page> {
  const db = await getDb();
  const current = await getAdminPageById(id);
  if (!current) {
    throw new AppError("not_found", `Page with id "${id}" not found`);
  }
  if (current.trashedAt !== null) {
    throw new AppError("invalid", "Trashed pages cannot be published. Restore the page first.");
  }

  assertPageTransition(current.status, "publish");

  const now = new Date();
  await db
    .update(pages)
    .set(buildPublishUpdate({ publishedAt: current.publishedAt }, now))
    .where(eq(pages.id, id));

  const published = (await getAdminPageById(id))!;
  await recordRevision(published, "publish", options?.createdBy);
  return published;
}

export async function unpublishPage(
  id: string,
  options?: { createdBy?: string | null }
): Promise<Page> {
  const db = await getDb();
  const current = await getAdminPageById(id);
  if (!current) {
    throw new AppError("not_found", `Page with id "${id}" not found`);
  }
  if (current.trashedAt !== null) {
    throw new AppError("invalid", "Trashed pages cannot be unpublished. Restore the page first.");
  }

  assertPageTransition(current.status, "unpublish");

  const now = new Date();
  await db.update(pages).set(buildUnpublishUpdate(now)).where(eq(pages.id, id));

  const draft = (await getAdminPageById(id))!;
  await recordRevision(draft, "unpublish", options?.createdBy);
  return draft;
}

export async function archivePage(
  id: string,
  options?: { createdBy?: string | null }
): Promise<Page> {
  const db = await getDb();
  const current = await getAdminPageById(id);
  if (!current) {
    throw new AppError("not_found", `Page with id "${id}" not found`);
  }
  if (current.trashedAt !== null) {
    throw new AppError("invalid", "Trashed pages cannot be archived. Restore the page first.");
  }

  assertPageTransition(current.status, "archive");

  const now = new Date();
  await db.update(pages).set(buildArchiveUpdate(now)).where(eq(pages.id, id));

  const archived = (await getAdminPageById(id))!;
  await recordRevision(archived, "archive", options?.createdBy);
  return archived;
}

/// §1 restore: archived -> draft (an editable state; never straight to
/// published).
export async function restorePageFromArchive(
  id: string,
  options?: { createdBy?: string | null }
): Promise<Page> {
  const db = await getDb();
  const current = await getAdminPageById(id);
  if (!current) {
    throw new AppError("not_found", `Page with id "${id}" not found`);
  }
  if (current.trashedAt !== null) {
    throw new AppError("invalid", "Trashed pages cannot be restored from archive. Restore from Trash first.");
  }

  assertPageTransition(current.status, "restore");

  const now = new Date();
  await db.update(pages).set(buildRestoreUpdate(now)).where(eq(pages.id, id));

  const draft = (await getAdminPageById(id))!;
  await recordRevision(draft, "restore", options?.createdBy);
  return draft;
}

/// §1 move to Trash: allowed from draft or archived only. Published pages
/// must be unpublished/archived first. Data, history and relationships are
/// kept; the slug stays reserved.
export async function movePageToTrash(id: string): Promise<Page> {
  const db = await getDb();
  const current = await getAdminPageById(id);
  if (!current) {
    throw new AppError("not_found", `Page with id "${id}" not found`);
  }
  if (current.trashedAt !== null) {
    throw new AppError("invalid", "This page is already in Trash.");
  }
  if (current.status === "published") {
    throw new AppError(
      "invalid",
      "Published pages cannot be moved to Trash. Unpublish or archive the page first."
    );
  }

  const now = new Date();
  await db
    .update(pages)
    .set({ trashedAt: now, trashedFromStatus: current.status, updatedAt: now })
    .where(eq(pages.id, id));

  const trashed = (await getAdminPageById(id))!;
  return trashed;
}

/// §1 restore from Trash: `trashed_at` cleared, status =
/// `trashed_from_status`.
export async function restorePageFromTrash(id: string, actorId: string): Promise<Page> {
  if (!actorId) {
    throw new AppError("unauthorized", "Unauthorized: You must be signed in");
  }
  const db = await getDb();
  const current = await getAdminPageById(id);
  if (!current) {
    throw new AppError("not_found", `Page with id "${id}" not found`);
  }
  if (current.trashedAt === null) {
    throw new AppError("invalid", "This page is not in Trash.");
  }

  const now = new Date();
  await db
    .update(pages)
    .set({
      trashedAt: null,
      status: current.trashedFromStatus ?? current.status,
      trashedFromStatus: null,
      updatedAt: now,
    })
    .where(eq(pages.id, id));

  const restored = (await getAdminPageById(id))!;
  return restored;
}

const MEDIA_URL_PREFIX = "/api/media/";

function mediaKeyFromUrl(url: string | null): string | null {
  if (!url || !url.startsWith(MEDIA_URL_PREFIX)) return null;
  const key = url.slice(MEDIA_URL_PREFIX.length);
  return key.length > 0 ? key : null;
}

/// Delete the page's cover media only when no other content references the
/// same object (§1 dependency rule for guides/field notes/pages). R2 and D1
/// media cleanup is best-effort: it never fails the permanent delete.
async function deleteUnreferencedPageMedia(page: Page): Promise<void> {
  const key = mediaKeyFromUrl(page.coverImage);
  if (!key) return;
  const url = page.coverImage as string;
  try {
    const db = await getDb();
    const [otherGuide, otherNote, otherPage] = await Promise.all([
      db.select({ id: guides.id }).from(guides).where(eq(guides.coverImage, url)).get(),
      db.select({ id: fieldNotes.id }).from(fieldNotes).where(eq(fieldNotes.coverImage, url)).get(),
      db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.coverImage, url), ne(pages.id, page.id)))
        .get(),
    ]);
    if (otherGuide || otherNote || otherPage) return;
    await db.delete(media).where(eq(media.key, key));
    try {
      const bucket = await getR2Bucket();
      await bucket.delete(key);
    } catch {
      // Best-effort: the D1 row is gone, a stray R2 object is harmless.
    }
  } catch {
    // Best-effort: media cleanup never fails the permanent delete.
  }
}

async function deletePageRows(id: string): Promise<void> {
  const db = await getDb();
  await db.batch([
    db.delete(pageRevisions).where(eq(pageRevisions.pageId, id)),
    // Redirects that pointed at this page die with it (§1).
    db.delete(slugRedirects).where(eq(slugRedirects.entityId, id)),
    db.delete(pages).where(eq(pages.id, id)),
  ]);
}

/// §1 delete permanently: trashed only, irreversible, typed confirmation
/// (the exact title). Returns a snapshot for the audit row.
export async function deletePagePermanently(
  id: string,
  actorId: string,
  confirmTitle: string
): Promise<{ id: string; title: string; slug: string }> {
  if (!actorId) {
    throw new AppError("unauthorized", "Unauthorized: You must be signed in");
  }
  const current = await getAdminPageById(id);
  if (!current) {
    throw new AppError("not_found", `Page with id "${id}" not found`);
  }
  if (current.trashedAt === null) {
    throw new AppError(
      "invalid",
      "Only trashed pages can be permanently deleted. Move the page to Trash first."
    );
  }
  if (confirmTitle !== current.title) {
    throw new AppError(
      "invalid",
      "The confirmation title does not match. Type the exact page title to confirm."
    );
  }

  await deleteUnreferencedPageMedia(current);
  await deletePageRows(id);
  return { id: current.id, title: current.title, slug: current.slug };
}

const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_BATCH_LIMIT = 20;

/// §1 auto-purge: permanently delete pages trashed for more than 30 days, in
/// small bounded batches. Pages have no blocking dependencies (no
/// enrollments or learner data), so every expired row is purged; anything
/// unexpected is reported in `kept` and stays in Trash.
export async function purgeExpiredPages(
  now: Date = new Date(),
  limit: number = PURGE_BATCH_LIMIT
): Promise<{ purged: string[]; kept: { id: string; reason: string }[] }> {
  const bounded = Math.max(1, Math.min(Math.floor(limit) || PURGE_BATCH_LIMIT, 100));
  const db = await getDb();
  const cutoff = new Date(now.getTime() - PURGE_AFTER_MS);
  const expired = await db
    .select()
    .from(pages)
    .where(and(isNotNull(pages.trashedAt), lt(pages.trashedAt, cutoff)))
    .orderBy(desc(pages.trashedAt))
    .limit(bounded);

  const purged: string[] = [];
  const kept: { id: string; reason: string }[] = [];
  for (const page of expired) {
    try {
      await deleteUnreferencedPageMedia(page);
      await deletePageRows(page.id);
      purged.push(page.id);
    } catch (error) {
      kept.push({ id: page.id, reason: error instanceof Error ? error.message : "Purge failed" });
    }
  }
  return { purged, kept };
}
