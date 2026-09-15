import type { ContentStatus } from "./types";

// ============================================================================
// SHARED PUBLISHING LIFECYCLE (Mission 05 extraction)
// ----------------------------------------------------------------------------
// Centralizes only the small common rules shared by Guides and Field Notes:
//   draft -> published -> archived, with unpublish returning to draft.
// Timestamp rules:
// - publish: status=published, publishedAt set once (first publish wins),
//   updatedAt=now.
// - unpublish: status=draft, updatedAt=now (publishedAt preserved for history).
// - archive: status=archived, updatedAt=now (publishedAt preserved).
// - edit: updatedAt=now (never touches publishedAt).
// Database access stays explicit per domain — no generic repositories.
// ============================================================================

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

export function buildEditTouch(now: Date = new Date()): { updatedAt: Date } {
  return { updatedAt: now };
}

// ----------------------------------------------------------------------------
// Field Note lifecycle enforcement (Mission 05 review correction)
// ----------------------------------------------------------------------------
// Archived is TERMINAL — there is no restore-from-archive in Mission 05.
// Valid transitions:
//   draft -> published (publish, incl. republish after unpublish)
//   published -> draft (unpublish)
//   published -> archived (archive)
//   draft -> archived (archive)
// Rejected: any transition from archived, plus meaningless repeats
// (published -> published, draft -> draft via unpublish).
// Guide services intentionally keep their previous behavior; only the
// Field Note service calls this guard.

export type FieldNoteTransition = "publish" | "unpublish" | "archive";

const FIELD_NOTE_ALLOWED_TRANSITIONS: Record<ContentStatus, FieldNoteTransition[]> = {
  draft: ["publish", "archive"],
  published: ["unpublish", "archive"],
  archived: [],
};

export function assertFieldNoteTransition(from: ContentStatus, action: FieldNoteTransition): void {
  const allowed = FIELD_NOTE_ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(action)) {
    if (from === "archived") {
      throw new Error(
        `Cannot ${action} an archived field note. Archived notes are terminal and cannot be republished, edited back to draft, or re-archived.`
      );
    }
    throw new Error(`Cannot ${action} a field note with status "${from}".`);
  }
}
