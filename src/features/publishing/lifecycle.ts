import type { ContentStatus } from "./types";
import { AppError } from "@/lib/errors";

// ============================================================================
// SHARED PUBLISHING LIFECYCLE (Mission 05 extraction; remediation D)
// ----------------------------------------------------------------------------
// Centralizes the common rules shared by Guides and Field Notes:
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
// Content lifecycle enforcement (Mission 06 final foundation remediation)
// ----------------------------------------------------------------------------
// Archived is TERMINAL — for BOTH Guides and Field Notes. There is no
// restore-from-archive. Valid transitions:
//   draft -> published (publish, incl. republish after unpublish)
//   published -> draft (unpublish)
//   published -> archived (archive)
//   draft -> archived (archive)
// Rejected: any transition from archived, plus meaningless repeats
// (published -> published, draft -> draft via unpublish).
// Both domain services call the same shared transition table; the per-domain
// wrappers only supply the domain name used in error messages.

export type ContentTransition = "publish" | "unpublish" | "archive";

const ALLOWED_TRANSITIONS: Record<ContentStatus, ContentTransition[]> = {
  draft: ["publish", "archive"],
  published: ["unpublish", "archive"],
  archived: [],
};

function assertContentTransition(
  domain: "guide" | "field note",
  from: ContentStatus,
  action: ContentTransition
): void {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(action)) {
    if (from === "archived") {
      throw new AppError("invalid",
        `Cannot ${action} an archived ${domain}. Archived content is terminal and cannot be republished, edited back to draft, or re-archived.`
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
