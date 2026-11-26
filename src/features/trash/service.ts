import {
  deleteLandingPagePermanently,
  getAdminLandingPageById,
  listTrashedLandingPages,
  moveLandingPageToTrash,
  purgeExpiredLandingPages,
  restoreLandingPageFromTrash,
} from "@/features/landing-pages/service";
import {
  deletePagePermanently,
  listTrashedPages,
  movePageToTrash,
  purgeExpiredPages,
  restorePageFromTrash,
} from "@/features/pages/service";
import { asc, eq, isNotNull, lte } from "drizzle-orm";
import {
  courses,
  fieldNotes,
  getDb,
  guides,
  lessons,
} from "@/lib/db";
import {
  TRASH_PURGE_BATCH_LIMIT,
  TRASH_RETENTION_DAYS,
  daysLeftBeforePurge,
  isTrashExpired,
} from "@/features/publishing/lifecycle";
import { recordAdminAudit } from "@/features/audit/service";
import {
  deleteCoursePermanently,
  assertCourseDeletable,
  deleteLessonPermanently,
  assertLessonDeletable,
  getAdminCourseById,
  restoreCourseFromTrash,
  restoreLessonFromTrash,
  trashCourse,
  trashLesson,
} from "@/features/courses/service";
import {
  deleteFieldNotePermanently,
  restoreFieldNoteFromTrash,
  trashFieldNote,
} from "@/features/field-notes/service";
import {
  deleteGuidePermanently,
  restoreGuideFromTrash,
  trashGuide,
} from "@/features/guides/service";

// ============================================================================
// TRASH REGISTRY (§1 lifecycle)
// ----------------------------------------------------------------------------
// One Trash page across content types. Each TrashableType plugs a content
// type into the shared list/purge machinery; the Studio actions and the
// 5-minute cron both dispatch through here so dependency checks run the
// same way manually and automatically. Items that fail a purge check stay
// in Trash and are flagged (see `protected` / `protectionReason`).
// D1 cost: one indexed `trashed_at` range scan per type, protection checks
// batched per row only on the small trashed set.
// ============================================================================

export type TrashTypeName = "guide" | "field_note" | "course" | "lesson" | "page" | "landing_page";

export interface TrashItem {
  type: TrashTypeName;
  typeLabel: string;
  id: string;
  title: string;
  slug: string;
  /** Status the row left (restored back on un-trash). */
  status: string;
  trashedAt: Date;
  /** Whole days left before the retention window expires (<= 0 = due). */
  daysLeft: number;
  expired: boolean;
  /** True when permanent delete is currently refused (dependency rule). */
  protected: boolean;
  protectionReason: string | null;
  /** Lessons carry their course title for context; absent otherwise. */
  courseTitle?: string;
}

export interface TrashableType {
  type: TrashTypeName;
  label: string;
  listTrashed(): Promise<TrashItem[]>;
  trash(id: string): Promise<TrashMutationResult>;
  restore(id: string, actorId: string): Promise<TrashMutationResult>;
  deletePermanently(id: string, actorId: string, confirmTitle: string): Promise<TrashMutationResult & { title: string; oldSlugs: string[] }>;
  purgeExpired(now: Date, limit: number): Promise<number>;
}

/** Snapshot returned by trash mutations for audit + cache revalidation. */
export interface TrashMutationResult {
  type: TrashTypeName;
  id: string;
  slug: string;
  title: string;
  status?: string;
  /** Lessons (and their parents) carry course context for revalidation. */
  courseId: string | null;
  courseSlug: string | null;
}

/** Actor recorded when the cron (not a human admin) deletes an item. */
export const TRASH_PURGE_ACTOR_ID = "system";

async function checkCourseProtection(id: string): Promise<{ protected: boolean; reason: string | null }> {
  try {
    await assertCourseDeletable(id);
    return { protected: false, reason: null };
  } catch (error) {
    return {
      protected: true,
      reason: error instanceof Error ? error.message : "This course cannot be deleted permanently.",
    };
  }
}

async function checkLessonProtection(id: string): Promise<{ protected: boolean; reason: string | null }> {
  try {
    await assertLessonDeletable(id);
    return { protected: false, reason: null };
  } catch (error) {
    return {
      protected: true,
      reason: error instanceof Error ? error.message : "This lesson cannot be deleted permanently.",
    };
  }
}

const guideType: TrashableType = {
  type: "guide",
  label: "Guide",
  async listTrashed(): Promise<TrashItem[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(guides)
      .where(isNotNull(guides.trashedAt))
      .orderBy(asc(guides.trashedAt));
    const now = new Date();
    return rows.map((row) => ({
      type: "guide" as const,
      typeLabel: "Guide",
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.trashedFromStatus ?? row.status,
      trashedAt: row.trashedAt as Date,
      daysLeft: daysLeftBeforePurge(row.trashedAt as Date, now),
      expired: isTrashExpired(row.trashedAt as Date, now),
      protected: false,
      protectionReason: null,
    }));
  },
  async trash(id: string): Promise<TrashMutationResult> {
    const trashed = await trashGuide(id);
    return { type: "guide", id, slug: trashed.slug, title: trashed.title, status: trashed.status, courseId: null, courseSlug: null };
  },
  async restore(id: string, actorId: string): Promise<TrashMutationResult> {
    const restored = await restoreGuideFromTrash(id);
    await recordAdminAudit({
      actorId,
      action: "guide.untrash",
      entityType: "guide",
      entityId: id,
      details: { slug: restored.slug, status: restored.status },
    });
    return { type: "guide", id, slug: restored.slug, title: restored.title, status: restored.status, courseId: null, courseSlug: null };
  },
  async deletePermanently(id: string, actorId: string, confirmTitle: string): Promise<TrashMutationResult & { title: string; oldSlugs: string[] }> {
    const deleted = await deleteGuidePermanently(id, confirmTitle);
    await recordAdminAudit({
      actorId,
      action: "guide.delete",
      entityType: "guide",
      entityId: id,
      details: { title: deleted.title, slug: deleted.slug, permanent: true },
    });
    return { type: "guide", id, ...deleted, courseId: null, courseSlug: null };
  },
  async purgeExpired(now: Date, limit: number): Promise<number> {
    const db = await getDb();
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(guides)
      .where(lte(guides.trashedAt, cutoff))
      .orderBy(asc(guides.trashedAt))
      .limit(limit);
    let purged = 0;
    for (const row of rows) {
      try {
        const deleted = await deleteGuidePermanently(row.id, row.title);
        purged += 1;
        await recordAdminAudit({
          actorId: TRASH_PURGE_ACTOR_ID,
          action: "guide.delete",
          entityType: "guide",
          entityId: row.id,
          details: { title: deleted.title, slug: deleted.slug, permanent: true, via: "purge" },
        });
      } catch {
        // Protection or race: the item stays in Trash and stays flagged.
      }
    }
    return purged;
  },
};

const fieldNoteType: TrashableType = {
  type: "field_note",
  label: "Field note",
  async listTrashed(): Promise<TrashItem[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(fieldNotes)
      .where(isNotNull(fieldNotes.trashedAt))
      .orderBy(asc(fieldNotes.trashedAt));
    const now = new Date();
    return rows.map((row) => ({
      type: "field_note" as const,
      typeLabel: "Field note",
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.trashedFromStatus ?? row.status,
      trashedAt: row.trashedAt as Date,
      daysLeft: daysLeftBeforePurge(row.trashedAt as Date, now),
      expired: isTrashExpired(row.trashedAt as Date, now),
      protected: false,
      protectionReason: null,
    }));
  },
  async trash(id: string): Promise<TrashMutationResult> {
    const trashed = await trashFieldNote(id);
    return { type: "field_note", id, slug: trashed.slug, title: trashed.title, status: trashed.status, courseId: null, courseSlug: null };
  },
  async restore(id: string, actorId: string): Promise<TrashMutationResult> {
    const restored = await restoreFieldNoteFromTrash(id);
    await recordAdminAudit({
      actorId,
      action: "field_note.untrash",
      entityType: "field_note",
      entityId: id,
      details: { slug: restored.slug, status: restored.status },
    });
    return { type: "field_note", id, slug: restored.slug, title: restored.title, status: restored.status, courseId: null, courseSlug: null };
  },
  async deletePermanently(id: string, actorId: string, confirmTitle: string): Promise<TrashMutationResult & { title: string; oldSlugs: string[] }> {
    const deleted = await deleteFieldNotePermanently(id, confirmTitle);
    await recordAdminAudit({
      actorId,
      action: "field_note.delete",
      entityType: "field_note",
      entityId: id,
      details: { title: deleted.title, slug: deleted.slug, permanent: true },
    });
    return { type: "field_note", id, ...deleted, courseId: null, courseSlug: null };
  },
  async purgeExpired(now: Date, limit: number): Promise<number> {
    const db = await getDb();
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(fieldNotes)
      .where(lte(fieldNotes.trashedAt, cutoff))
      .orderBy(asc(fieldNotes.trashedAt))
      .limit(limit);
    let purged = 0;
    for (const row of rows) {
      try {
        const deleted = await deleteFieldNotePermanently(row.id, row.title);
        purged += 1;
        await recordAdminAudit({
          actorId: TRASH_PURGE_ACTOR_ID,
          action: "field_note.delete",
          entityType: "field_note",
          entityId: row.id,
          details: { title: deleted.title, slug: deleted.slug, permanent: true, via: "purge" },
        });
      } catch {
        // Protection or race: the item stays in Trash and stays flagged.
      }
    }
    return purged;
  },
};

const courseType: TrashableType = {
  type: "course",
  label: "Course",
  async listTrashed(): Promise<TrashItem[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(courses)
      .where(isNotNull(courses.trashedAt))
      .orderBy(asc(courses.trashedAt));
    const now = new Date();
    return Promise.all(
      rows.map(async (row) => {
        const protection = await checkCourseProtection(row.id);
        return {
          type: "course" as const,
          typeLabel: "Course",
          id: row.id,
          title: row.title,
          slug: row.slug,
          status: row.trashedFromStatus ?? row.status,
          trashedAt: row.trashedAt as Date,
          daysLeft: daysLeftBeforePurge(row.trashedAt as Date, now),
          expired: isTrashExpired(row.trashedAt as Date, now),
          protected: protection.protected,
          protectionReason: protection.reason,
        };
      })
    );
  },
  async trash(id: string): Promise<TrashMutationResult> {
    const trashed = await trashCourse(id);
    return { type: "course", id, slug: trashed.slug, title: trashed.title, status: trashed.status, courseId: id, courseSlug: trashed.slug };
  },
  async restore(id: string, actorId: string): Promise<TrashMutationResult> {
    const restored = await restoreCourseFromTrash(id);
    await recordAdminAudit({
      actorId,
      action: "course.untrash",
      entityType: "course",
      entityId: id,
      details: { slug: restored.slug, status: restored.status },
    });
    return { type: "course", id, slug: restored.slug, title: restored.title, status: restored.status, courseId: id, courseSlug: restored.slug };
  },
  async deletePermanently(id: string, actorId: string, confirmTitle: string): Promise<TrashMutationResult & { title: string; oldSlugs: string[] }> {
    const deleted = await deleteCoursePermanently(id, confirmTitle);
    await recordAdminAudit({
      actorId,
      action: "course.delete",
      entityType: "course",
      entityId: id,
      details: { title: deleted.title, slug: deleted.slug, permanent: true },
    });
    return { type: "course", id, ...deleted, courseId: id, courseSlug: deleted.slug };
  },
  async purgeExpired(now: Date, limit: number): Promise<number> {
    const db = await getDb();
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(courses)
      .where(lte(courses.trashedAt, cutoff))
      .orderBy(asc(courses.trashedAt))
      .limit(limit);
    let purged = 0;
    for (const row of rows) {
      try {
        const deleted = await deleteCoursePermanently(row.id, row.title);
        purged += 1;
        await recordAdminAudit({
          actorId: TRASH_PURGE_ACTOR_ID,
          action: "course.delete",
          entityType: "course",
          entityId: row.id,
          details: { title: deleted.title, slug: deleted.slug, permanent: true, via: "purge" },
        });
      } catch {
        // Protected (learners attached) or raced: stays in Trash, flagged.
      }
    }
    return purged;
  },
};

const lessonType: TrashableType = {
  type: "lesson",
  label: "Lesson",
  async listTrashed(): Promise<TrashItem[]> {
    const db = await getDb();
    const rows = await db
      .select({ lesson: lessons, courseTitle: courses.title, courseSlug: courses.slug })
      .from(lessons)
      .innerJoin(courses, eq(courses.id, lessons.courseId))
      .where(isNotNull(lessons.trashedAt))
      .orderBy(asc(lessons.trashedAt));
    const now = new Date();
    return Promise.all(
      rows.map(async ({ lesson, courseTitle }) => {
        const protection = await checkLessonProtection(lesson.id);
        return {
          type: "lesson" as const,
          typeLabel: `Lesson · ${courseTitle}`,
          id: lesson.id,
          title: lesson.title,
          slug: lesson.slug,
          status: lesson.trashedFromStatus ?? lesson.status,
          trashedAt: lesson.trashedAt as Date,
          daysLeft: daysLeftBeforePurge(lesson.trashedAt as Date, now),
          expired: isTrashExpired(lesson.trashedAt as Date, now),
          protected: protection.protected,
          protectionReason: protection.reason,
          courseTitle,
        };
      })
    );
  },
  async trash(id: string): Promise<TrashMutationResult> {
    const trashed = await trashLesson(id);
    const course = await getAdminCourseById(trashed.courseId);
    return { type: "lesson", id, slug: trashed.slug, title: trashed.title, status: trashed.status, courseId: trashed.courseId, courseSlug: course?.slug ?? null };
  },
  async restore(id: string, actorId: string): Promise<TrashMutationResult> {
    const restored = await restoreLessonFromTrash(id);
    await recordAdminAudit({
      actorId,
      action: "lesson.untrash",
      entityType: "lesson",
      entityId: id,
      details: { courseId: restored.courseId, slug: restored.slug, status: restored.status },
    });
    const course = await getAdminCourseById(restored.courseId);
    return { type: "lesson", id, slug: restored.slug, title: restored.title, status: restored.status, courseId: restored.courseId, courseSlug: course?.slug ?? null };
  },
  async deletePermanently(id: string, actorId: string, confirmTitle: string): Promise<TrashMutationResult & { title: string; oldSlugs: string[] }> {
    const deleted = await deleteLessonPermanently(id, confirmTitle);
    await recordAdminAudit({
      actorId,
      action: "lesson.delete",
      entityType: "lesson",
      entityId: id,
      details: { title: deleted.title, slug: deleted.slug, permanent: true },
    });
    return { type: "lesson", id, ...deleted };
  },
  async purgeExpired(now: Date, limit: number): Promise<number> {
    const db = await getDb();
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(lessons)
      .where(lte(lessons.trashedAt, cutoff))
      .orderBy(asc(lessons.trashedAt))
      .limit(limit);
    let purged = 0;
    for (const row of rows) {
      try {
        const deleted = await deleteLessonPermanently(row.id, row.title);
        purged += 1;
        await recordAdminAudit({
          actorId: TRASH_PURGE_ACTOR_ID,
          action: "lesson.delete",
          entityType: "lesson",
          entityId: row.id,
          details: { title: deleted.title, slug: deleted.slug, permanent: true, via: "purge" },
        });
      } catch {
        // Protected (learner data attached) or raced: stays in Trash, flagged.
      }
    }
    return purged;
  },
};

/** Registry of trashable content types. Other builders plug new types in here. */
const pageType: TrashableType = {
  type: "page",
  label: "Page",
  async listTrashed(): Promise<TrashItem[]> {
    const rows = await listTrashedPages();
    const now = new Date();
    return rows.map((row) => ({
      type: "page" as const,
      typeLabel: "Page",
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.trashedFromStatus ?? row.status,
      trashedAt: row.trashedAt as Date,
      daysLeft: daysLeftBeforePurge(row.trashedAt as Date, now),
      expired: isTrashExpired(row.trashedAt as Date, now),
      protected: false,
      protectionReason: null,
    }));
  },
  async trash(id: string): Promise<TrashMutationResult> {
    const trashed = await movePageToTrash(id);
    return { type: "page", id, slug: trashed.slug, title: trashed.title, status: trashed.status, courseId: null, courseSlug: null };
  },
  async restore(id: string, actorId: string): Promise<TrashMutationResult> {
    const restored = await restorePageFromTrash(id, actorId);
    await recordAdminAudit({
      actorId,
      action: "page.untrash",
      entityType: "page",
      entityId: id,
      details: { slug: restored.slug, status: restored.status },
    });
    return { type: "page", id, slug: restored.slug, title: restored.title, status: restored.status, courseId: null, courseSlug: null };
  },
  async deletePermanently(id: string, actorId: string, confirmTitle: string): Promise<TrashMutationResult & { title: string; oldSlugs: string[] }> {
    const deleted = await deletePagePermanently(id, actorId, confirmTitle);
    await recordAdminAudit({
      actorId,
      action: "page.delete",
      entityType: "page",
      entityId: id,
      details: { title: deleted.title, slug: deleted.slug, permanent: true },
    });
    return { type: "page", id, slug: deleted.slug, title: deleted.title, oldSlugs: [], courseId: null, courseSlug: null };
  },
  async purgeExpired(now: Date, limit: number): Promise<number> {
    const { purged } = await purgeExpiredPages(now, limit);
    return purged.length;
  },
};

// Landing page services write their own audit rows.
const landingPageType: TrashableType = {
  type: "landing_page",
  label: "Landing page",
  async listTrashed(): Promise<TrashItem[]> {
    const rows = await listTrashedLandingPages();
    const now = new Date();
    return rows.map((row) => ({
      type: "landing_page" as const,
      typeLabel: "Landing page",
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.trashedFromStatus ?? row.status,
      trashedAt: row.trashedAt as Date,
      daysLeft: daysLeftBeforePurge(row.trashedAt as Date, now),
      expired: isTrashExpired(row.trashedAt as Date, now),
      protected: false,
      protectionReason: null,
    }));
  },
  async trash(id: string): Promise<TrashMutationResult> {
    const trashed = await moveLandingPageToTrash(id);
    return { type: "landing_page", id, slug: trashed.slug, title: trashed.title, status: trashed.status, courseId: null, courseSlug: null };
  },
  async restore(id: string, actorId: string): Promise<TrashMutationResult> {
    const restored = await restoreLandingPageFromTrash(id, actorId);
    return { type: "landing_page", id, slug: restored.slug, title: restored.title, status: restored.status, courseId: null, courseSlug: null };
  },
  async deletePermanently(id: string, actorId: string, confirmTitle: string): Promise<TrashMutationResult & { title: string; oldSlugs: string[] }> {
    const current = await getAdminLandingPageById(id);
    await deleteLandingPagePermanently(id, actorId, confirmTitle);
    return { type: "landing_page", id, slug: current?.slug ?? "", title: current?.title ?? "", oldSlugs: [], courseId: null, courseSlug: null };
  },
  async purgeExpired(now: Date, limit: number): Promise<number> {
    return (await purgeExpiredLandingPages(now, limit)).length;
  },
};

export const TRASHABLE_TYPES: TrashableType[] = [guideType, fieldNoteType, courseType, lessonType, pageType, landingPageType];

export function getTrashableType(type: string): TrashableType | null {
  return TRASHABLE_TYPES.find((t) => t.type === type) ?? null;
}

/** All trashed items across registered types, oldest first per type. */
export async function listTrash(): Promise<TrashItem[]> {
  const perType = await Promise.all(TRASHABLE_TYPES.map((t) => t.listTrashed()));
  return perType.flat().sort((a, b) => a.trashedAt.getTime() - b.trashedAt.getTime());
}

/**
 * Purge items trashed longer than the retention window, a few per type per
 * run (Workers Free 10 ms CPU budget). Returns the total purged count.
 * Items failing a dependency check stay in Trash and stay flagged.
 */
export async function purgeExpiredTrash(now: Date = new Date(), limitPerType: number = TRASH_PURGE_BATCH_LIMIT): Promise<number> {
  let purged = 0;
  for (const type of TRASHABLE_TYPES) {
    purged += await type.purgeExpired(now, limitPerType);
  }
  return purged;
}
