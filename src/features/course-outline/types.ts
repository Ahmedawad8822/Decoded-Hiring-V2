// ============================================================================
// AI COURSE OUTLINE — DOMAIN TYPES
// ----------------------------------------------------------------------------
// The instructor gives a short brief; the service returns a proposed outline
// of sections → lessons grounded in the knowledge library. The instructor
// reviews it in Studio and applies the parts they want as draft sections and
// lessons. Nothing here persists an outline — generation is stateless; only
// the explicit "add selected" step writes rows (see service.ts).
//
// Caps (brief requirement): at most 12 sections, at most 12 lessons each.
// ============================================================================

import { z } from "zod";

export const MAX_OUTLINE_SECTIONS = 12;
export const MAX_OUTLINE_LESSONS_PER_SECTION = 12;

// ---------------------------------------------------------------------------
// Brief (instructor input)
// ---------------------------------------------------------------------------

export const outlineBriefSchema = z.object({
  courseId: z.string().min(1),
  topic: z.string().trim().min(3, "Topic must be at least 3 characters").max(200),
  audience: z.string().trim().max(500).optional(),
  outcomes: z.string().trim().max(1000).optional(),
  lengthHint: z.string().trim().max(200).optional(),
});

export type OutlineBrief = z.infer<typeof outlineBriefSchema>;

// ---------------------------------------------------------------------------
// Raw model output (lenient — sanitized after validation, never trusted)
// ---------------------------------------------------------------------------

// Raw model output is deliberately lenient on scalar ranges: sanitize()
// clamps titles/summaries/durations and drops unknown source ids after
// validation, so an over-long or out-of-range value is repaired, not fatal.
export const rawOutlineLessonSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  durationMinutes: z.number().int().optional().nullable(),
  sourceIds: z.array(z.string()).max(10).optional().default([]),
});

export const rawOutlineSectionSchema = z.object({
  title: z.string().min(1),
  lessons: z.array(rawOutlineLessonSchema).min(1).max(MAX_OUTLINE_LESSONS_PER_SECTION),
});

export const rawOutlineSchema = z.object({
  sections: z.array(rawOutlineSectionSchema).min(1).max(MAX_OUTLINE_SECTIONS),
});

export type RawOutline = z.infer<typeof rawOutlineSchema>;

// ---------------------------------------------------------------------------
// Sanitized outline (safe for Studio display and for apply)
// ---------------------------------------------------------------------------

export interface OutlineLesson {
  title: string;
  summary: string;
  durationMinutes: number | null;
  /** Cited knowledge source ids — always a subset of the retrieved set. */
  sourceIds: string[];
}

export interface OutlineSection {
  title: string;
  lessons: OutlineLesson[];
}

/** Retrieved evidence surfaced next to the outline for review. */
export interface OutlineSource {
  sourceId: string;
  sourceTitle: string;
  chunkId: string;
  heading: string | null;
  ordinal: number;
}

export interface CourseOutlineDraft {
  sections: OutlineSection[];
  sources: OutlineSource[];
}

// ---------------------------------------------------------------------------
// Apply (instructor selection — only what is sent is created)
// ---------------------------------------------------------------------------

const applyLessonSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(2000),
  durationMinutes: z.number().int().min(1).max(600).optional().nullable(),
});

const applySectionSchema = z.object({
  title: z.string().trim().min(1).max(160),
  lessons: z.array(applyLessonSchema).min(1).max(MAX_OUTLINE_LESSONS_PER_SECTION),
});

export const applyOutlineSchema = z.object({
  courseId: z.string().min(1),
  sections: z.array(applySectionSchema).min(1).max(MAX_OUTLINE_SECTIONS),
});

export type ApplyOutlineInput = z.infer<typeof applyOutlineSchema>;

export interface ApplyOutlineResult {
  sectionIds: string[];
  lessonIds: string[];
  sectionCount: number;
  lessonCount: number;
}
