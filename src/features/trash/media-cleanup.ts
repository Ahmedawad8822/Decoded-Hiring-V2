import { and, eq, like, ne, or } from "drizzle-orm";
import {
  courses,
  fieldNotes,
  getDb,
  guides,
  lessons,
  media,
} from "@/lib/db";
import { getR2Bucket } from "@/lib/cloudflare/bindings";
import { isPublicMediaKey } from "@/lib/media/service";

// ============================================================================
// TRASH MEDIA CLEANUP (§1 lifecycle dependency rules)
// ----------------------------------------------------------------------------
// Leaf module (imports schema only — never domain services, so the trash
// registry can use it without import cycles).
//
// Permanent delete of a guide / field note / course removes revisions, slug
// redirects pointing at it, and its R2 media ONLY when no other content
// references the same object. Cover images are stored as `/api/media/<key>`
// URLs; body blocks may also embed those URLs.
// ============================================================================

const MEDIA_URL_PREFIX = "/api/media/";

/** Extract the R2 key from a stored `/api/media/<key>` URL, or null. */
export function extractPublicMediaKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith(MEDIA_URL_PREFIX)) return null;
  const key = trimmed.slice(MEDIA_URL_PREFIX.length).split("?")[0].replace(/^\/+/, "");
  if (!key || key.includes("..") || !isPublicMediaKey(key)) return null;
  return key;
}

/**
 * All candidate R2 keys referenced by a trashed row: its cover image plus
 * any `/api/media/<key>` URL embedded in its body JSON.
 */
export function collectContentMediaKeys(
  coverImage: string | null | undefined,
  body: string | null | undefined
): string[] {
  const keys = new Set<string>();
  const cover = extractPublicMediaKey(coverImage);
  if (cover) keys.add(cover);
  if (body) {
    const pattern = /\/api\/media\/([A-Za-z0-9_\-/.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const key = match[1].replace(/^\/+/, "");
      if (!key.includes("..") && isPublicMediaKey(key)) keys.add(key);
    }
  }
  return [...keys];
}

type ContentTable = "guides" | "field_notes" | "courses";

/**
 * True when any OTHER content row (any status, including Trash) still
 * references the key via cover image or body/description text. The row being
 * deleted is excluded by id so its own references do not protect the object.
 */
export async function isMediaKeyReferencedElsewhere(
  key: string,
  exclude: { table: ContentTable; id: string; coverImage: string | null }
): Promise<boolean> {
  const db = await getDb();
  const urlPattern = `%${MEDIA_URL_PREFIX}${key}%`;
  const keyPattern = `%${key}%`;

  // Every column that can hold the key (as a URL or a bare key) counts:
  // cover images, guide OG images, block bodies and course descriptions.
  const guideRows = await db
    .select({ id: guides.id })
    .from(guides)
    .where(
      and(
        or(like(guides.body, urlPattern), like(guides.coverImage, keyPattern), like(guides.ogImage, keyPattern)),
        exclude.table === "guides" ? ne(guides.id, exclude.id) : undefined
      )
    )
    .limit(1);
  if (guideRows.length > 0) return true;

  const noteRows = await db
    .select({ id: fieldNotes.id })
    .from(fieldNotes)
    .where(
      and(
        or(like(fieldNotes.body, urlPattern), like(fieldNotes.coverImage, keyPattern)),
        exclude.table === "field_notes" ? ne(fieldNotes.id, exclude.id) : undefined
      )
    )
    .limit(1);
  if (noteRows.length > 0) return true;

  const courseRows = await db
    .select({ id: courses.id })
    .from(courses)
    .where(
      and(
        or(like(courses.description, urlPattern), like(courses.coverImage, keyPattern)),
        exclude.table === "courses" ? ne(courses.id, exclude.id) : undefined
      )
    )
    .limit(1);
  if (courseRows.length > 0) return true;

  const lessonRows = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(like(lessons.body, urlPattern))
    .limit(1);
  return lessonRows.length > 0;
}

/**
 * Delete R2 objects (and their `media` metadata rows) for keys no other
 * content references. D1 rows are deleted first by the caller; R2 cleanup is
 * best-effort and never throws — an orphaned object is harmless, a missing
 * one is not an error.
 */
export async function deleteMediaIfUnreferenced(
  keys: string[],
  exclude: { table: ContentTable; id: string; coverImage: string | null }
): Promise<void> {
  if (keys.length === 0) return;
  const db = await getDb();
  const bucket = await getR2Bucket();
  for (const key of keys) {
    try {
      if (await isMediaKeyReferencedElsewhere(key, exclude)) continue;
      await db.delete(media).where(eq(media.key, key));
      await bucket.delete(key).catch(() => undefined);
    } catch {
      // Best-effort only: permanent delete must not fail on R2 cleanup.
    }
  }
}
