import { and, eq } from "drizzle-orm";
import {
  courses,
  fieldNotes,
  getDb,
  guides,
  lessons,
  slugRedirects,
  type Database,
  type SlugRedirectEntityType,
} from "@/lib/db";

// ============================================================================
// SLUG REDIRECTS (blueprint §10: clean canonical URLs, discoverability gate)
// ----------------------------------------------------------------------------
// Policy:
//  - A redirect is recorded only when the entity has EVER been published
//    (publishedAt != null; unpublish/archive preserve it). Drafts never had a
//    public URL, so renaming them records nothing.
//  - Rows store entity_id, never the destination slug: the target is resolved
//    at request time, so A -> B -> C resolves A to C.
//  - A live entity always wins: whenever an entity takes a slug (create or
//    rename) any redirect row for that slug is deleted in the same batch.
//  - Lesson slugs are scoped by course id; other entities use scope ''.
// ============================================================================

export interface SlugKey {
  entityType: SlugRedirectEntityType;
  scope: string;
  slug: string;
}

/** Statement that frees a slug for a live entity (reuse rule). */
export function buildReleaseSlugStatement(db: Database, key: SlugKey) {
  return db
    .delete(slugRedirects)
    .where(
      and(
        eq(slugRedirects.entityType, key.entityType),
        eq(slugRedirects.scope, key.scope),
        eq(slugRedirects.oldSlug, key.slug)
      )
    );
}

/**
 * Statements to run in the SAME D1 batch as the slug-changing UPDATE.
 * Returns [] when the slug did not change. `everPublished` gates recording.
 */
export function buildSlugChangeStatements(
  db: Database,
  params: {
    entityType: SlugRedirectEntityType;
    scope?: string;
    entityId: string;
    oldSlug: string;
    newSlug: string;
    everPublished: boolean;
    now: Date;
  }
) {
  if (params.oldSlug === params.newSlug) return [];
  const scope = params.scope ?? "";
  const statements = [
    // Live entity wins: the new slug can no longer be a redirect source.
    buildReleaseSlugStatement(db, {
      entityType: params.entityType,
      scope,
      slug: params.newSlug,
    }),
  ];
  if (params.everPublished) {
    statements.push(
      db
        .insert(slugRedirects)
        .values({
          id: `slugredir_${crypto.randomUUID().slice(0, 12)}`,
          entityType: params.entityType,
          scope,
          oldSlug: params.oldSlug,
          entityId: params.entityId,
          createdAt: params.now,
        })
        .onConflictDoUpdate({
          target: [slugRedirects.entityType, slugRedirects.scope, slugRedirects.oldSlug],
          set: { entityId: params.entityId, createdAt: params.now },
        }) as unknown as ReturnType<typeof buildReleaseSlugStatement>
    );
  }
  return statements;
}

async function findRedirectEntityId(key: SlugKey): Promise<string | null> {
  const db = await getDb();
  const row = await db
    .select({ entityId: slugRedirects.entityId })
    .from(slugRedirects)
    .where(
      and(
        eq(slugRedirects.entityType, key.entityType),
        eq(slugRedirects.scope, key.scope),
        eq(slugRedirects.oldSlug, key.slug)
      )
    )
    .get();
  return row?.entityId ?? null;
}

/** Current public path for a once-renamed guide slug, or null (-> 404). */
export async function resolveGuideRedirect(oldSlug: string): Promise<string | null> {
  const entityId = await findRedirectEntityId({ entityType: "guide", scope: "", slug: oldSlug });
  if (!entityId) return null;
  const db = await getDb();
  const row = await db.select().from(guides).where(eq(guides.id, entityId)).get();
  if (!row || row.status !== "published" || row.slug === oldSlug) return null;
  return `/guides/${row.slug}`;
}

export async function resolveFieldNoteRedirect(oldSlug: string): Promise<string | null> {
  const entityId = await findRedirectEntityId({ entityType: "field_note", scope: "", slug: oldSlug });
  if (!entityId) return null;
  const db = await getDb();
  const row = await db.select().from(fieldNotes).where(eq(fieldNotes.id, entityId)).get();
  if (!row || row.status !== "published" || row.slug === oldSlug) return null;
  return `/field-notes/${row.slug}`;
}

/** Courses stay reachable when archived (entitled learners), so only drafts are excluded. */
export async function resolveCourseRedirect(oldSlug: string): Promise<string | null> {
  const entityId = await findRedirectEntityId({ entityType: "course", scope: "", slug: oldSlug });
  if (!entityId) return null;
  const db = await getDb();
  const row = await db.select().from(courses).where(eq(courses.id, entityId)).get();
  if (!row || row.status === "draft" || row.slug === oldSlug) return null;
  return `/learn/courses/${row.slug}`;
}

/**
 * Resolves a lesson URL whose course slug and/or lesson slug may be stale.
 * `courseSlug` may be current or an old (redirected) course slug.
 * Returns the current lesson path, or null when nothing applies / nothing
 * would change (-> normal 404).
 */
export async function resolveLessonRedirect(
  courseSlug: string,
  lessonSlug: string
): Promise<string | null> {
  const db = await getDb();
  let course = await db.select().from(courses).where(eq(courses.slug, courseSlug)).get();
  if (!course) {
    const courseId = await findRedirectEntityId({ entityType: "course", scope: "", slug: courseSlug });
    if (!courseId) return null;
    course = await db.select().from(courses).where(eq(courses.id, courseId)).get();
  }
  if (!course || course.status === "draft") return null;

  let lesson = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.courseId, course.id), eq(lessons.slug, lessonSlug)))
    .get();
  if (!lesson) {
    const lessonId = await findRedirectEntityId({
      entityType: "lesson",
      scope: course.id,
      slug: lessonSlug,
    });
    if (!lessonId) return null;
    lesson = await db.select().from(lessons).where(eq(lessons.id, lessonId)).get();
  }
  if (!lesson || lesson.courseId !== course.id || lesson.status !== "published") return null;
  if (course.slug === courseSlug && lesson.slug === lessonSlug) return null;
  return `/learn/courses/${course.slug}/lessons/${lesson.slug}`;
}
