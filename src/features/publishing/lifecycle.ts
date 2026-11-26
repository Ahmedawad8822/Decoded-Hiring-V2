import type { ContentStatus } from "./types";
import { AppError } from "@/lib/errors";

// ============================================================================
// SHARED PUBLISHING LIFECYCLE (Mission 05 extraction; remediation D)
// ----------------------------------------------------------------------------
// Centralizes the common rules shared by Guides and Field Notes:
//   draft -> published -> archived, with unpublish returning to draft and
//   restore-from-archive returning to draft (never straight to published).
// Timestamp rules:
// - publish: status=published, publishedAt set once (first publish wins),
//   updatedAt=now.
// - unpublish: status=draft, updatedAt=now (publishedAt preserved for history).
// - archive: status=archived, updatedAt=now (publishedAt preserved).
// - restore (from archive): status=draft, updatedAt=now (publishedAt
//   preserved, so a re-publish needs no new slug-redirect handling).
// - edit: updatedAt=now (never touches publishedAt).
// Trash (§1 lifecycle) is a separate flag, not a status: trashed rows keep
// their status in trashedFromStatus and are hidden from every normal Studio
// list and every public/learner view until restored or purged.
// Database access stays explicit per domain — no generic repositories.
// ============================================================================

/** Days a trashed item is kept before the 5-minute cron may purge it. */
export const TRASH_RETENTION_DAYS = 30;

/** Upper bound on rows purged per trash type per cron run (small batches). */
export const TRASH_PURGE_BATCH_LIMIT = 5;

export interface LifecycleTimestamps {
  publishedAt: Date | null;
  updatedAt: Date;
}

export function buildPublishUpdate(
  current: { publishedAt: Date | null },
  now: Date = new Date()
): { status: ContentStatus; publishedAt: Date; updatedAt: Date } {
  return {
    status: "published",
    publishedAt: current.publishedAt ?? now,
    updatedAt: now,
  };
}

export function buildUnpublishUpdate(
  now: Date = new Date()
): { status: ContentStatus; updatedAt: Date } {
  return { status: "draft", updatedAt: now };
}

export function buildArchiveUpdate(
  now: Date = new Date()
): { status: ContentStatus; updatedAt: Date } {
  return { status: "archived", updatedAt: now };
}

export function buildRestoreFromArchiveUpdate(
  now: Date = new Date()
): { status: ContentStatus; updatedAt: Date } {
  // Restored content always returns to an editable state (draft) — never
  // straight to published.
  return { status: "draft", updatedAt: now };
}

export function buildEditTouch(now: Date = new Date()): { updatedAt: Date } {
  return { updatedAt: now };
}

// ----------------------------------------------------------------------------
// Trash flag updates (§1 lifecycle)
// ----------------------------------------------------------------------------

export interface TrashState {
  status: ContentStatus;
  trashedAt: Date | null;
  trashedFromStatus: ContentStatus | null;
}

/**
 * Move to Trash. Allowed only from draft or archived — a published item must
 * be unpublished/archived first. Records the status the row left so restore
 * can put it back.
 */
export function buildTrashUpdate(
  current: TrashState,
  now: Date = new Date()
): { trashedAt: Date; trashedFromStatus: ContentStatus; updatedAt: Date } {
  assertTrashable(current);
  return { trashedAt: now, trashedFromStatus: current.status, updatedAt: now };
}

/** Restore from Trash: clears the flag and returns to the recorded status. */
export function buildRestoreFromTrashUpdate(
  current: TrashState,
  now: Date = new Date()
): { status: ContentStatus; trashedAt: null; trashedFromStatus: null; updatedAt: Date } {
  if (!current.trashedAt || !current.trashedFromStatus) {
    throw new AppError("invalid", "This item is not in Trash.");
  }
  return {
    status: current.trashedFromStatus,
    trashedAt: null,
    trashedFromStatus: null,
    updatedAt: now,
  };
}

/** True when the row is currently in Trash. */
export function isTrashed(row: { trashedAt: Date | null }): boolean {
  return row.trashedAt !== null;
}

/** Lifecycle actions never apply to trashed rows — restore from Trash first. */
export function assertNotTrashed(row: { trashedAt: Date | null }, domain: string): void {
  if (row.trashedAt !== null) {
    throw new AppError("invalid", `This ${domain} is in Trash. Restore it before changing its status.`);
  }
}

/**
 * Whether a non-trashed row may move to Trash. Published rows must be
 * unpublished or archived first (their public URL must go away deliberately,
 * not as a side effect of trashing).
 */
export function assertTrashable(current: { status: ContentStatus; trashedAt: Date | null }): void {
  if (current.trashedAt !== null) {
    throw new AppError("invalid", "This item is already in Trash.");
  }
  if (current.status !== "draft" && current.status !== "archived") {
    throw new AppError(
      "invalid",
      `Unpublish or archive before moving to Trash (status is "${current.status}").`
    );
  }
}

/** Whole days remaining before the retention window expires (<= 0 = due). */
export function daysLeftBeforePurge(trashedAt: Date, now: Date = new Date()): number {
  const elapsedMs = now.getTime() - new Date(trashedAt).getTime();
  const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
  return TRASH_RETENTION_DAYS - elapsedDays;
}

/** True when the row has been trashed longer than the retention window. */
export function isTrashExpired(trashedAt: Date, now: Date = new Date()): boolean {
  const cutoff = now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return new Date(trashedAt).getTime() <= cutoff;
}

// ----------------------------------------------------------------------------
// Content lifecycle enforcement (Mission 06 final quality remediation)
// ----------------------------------------------------------------------------
// Valid transitions:
//   draft -> published (publish, incl. republish after unpublish)
//   published -> draft (unpublish)
//   published -> archived (archive)
//   draft -> archived (archive)
//   archived -> draft (restore)
// Rejected: meaningless repeats (published -> published, draft -> draft via
// unpublish) and any publish/unpublish/archive action from archived except
// restore.
// Both domain services call the same shared transition table; the per-domain
// wrappers only supply the domain name used in error messages.

export type ContentTransition = "publish" | "unpublish" | "archive" | "restore";

const ALLOWED_TRANSITIONS: Record<ContentStatus, ContentTransition[]> = {
  draft: ["publish", "archive"],
  published: ["unpublish", "archive"],
  archived: ["restore"],
};

function assertContentTransition(
  domain: string,
  from: ContentStatus,
  action: ContentTransition
): void {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(action)) {
    if (from === "archived" && action !== "restore") {
      throw new AppError("invalid",
        `Cannot ${action} an archived ${domain}. Restore it to draft first.`
      );
    }
    throw new AppError("invalid", `Cannot ${action} a ${domain} with status "${from}".`);
  }
}

export function assertFieldNoteTransition(from: ContentStatus, action: ContentTransition): void {
  assertContentTransition("field note", from, action);
}

export function assertGuideTransition(from: ContentStatus, action: ContentTransition): void {
  assertContentTransition("guide", from, action);
}

export function assertCourseTransition(from: ContentStatus, action: ContentTransition): void {
  assertContentTransition("course", from, action);
}

export function assertLessonTransition(from: ContentStatus, action: ContentTransition): void {
  assertContentTransition("lesson", from, action);
}
