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
