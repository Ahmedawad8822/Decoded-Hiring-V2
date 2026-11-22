import { z } from "zod";
import type { LessonNote } from "@/lib/db";
import { NOTE_MAX_BODY, normalizeNoteBody } from "./constants";

export { NOTE_MAX_BODY, NOTE_THROTTLE_MS, normalizeNoteBody } from "./constants";

// ============================================================================
// PRIVATE LESSON NOTES DOMAIN TYPES
// ----------------------------------------------------------------------------
// Notes are owner-only plain text. The server normalises to NFC and trims
// before enforcing the cap; an empty normalised body means "delete". Control
// characters other than newline and tab are rejected so the stored value is
// safe to render verbatim (never as HTML).
// ============================================================================

// Everything in the C0 range plus DEL, except TAB (0x09) and LF (0x0A).
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export const noteBodySchema = z
  .string()
  .transform((value) => normalizeNoteBody(value))
  .refine((value) => value.length <= NOTE_MAX_BODY, {
    message: `Notes can be at most ${NOTE_MAX_BODY.toLocaleString("en-US")} characters.`,
  })
  .refine((value) => !CONTROL_CHARS.test(value), {
    message: "Notes can contain plain text only (no control characters).",
  });

const slugSchema = z.string().trim().min(1).max(200);

export const saveLessonNoteSchema = z.object({
  courseSlug: slugSchema,
  lessonSlug: slugSchema,
  body: noteBodySchema,
});

export const deleteLessonNoteSchema = z.object({
  courseSlug: slugSchema,
  lessonSlug: slugSchema,
});

export type SaveLessonNoteInput = z.infer<typeof saveLessonNoteSchema>;
export type DeleteLessonNoteInput = z.infer<typeof deleteLessonNoteSchema>;

export interface SaveLessonNoteResult {
  /** Null when the save was an empty body, which deletes the note. */
  updatedAt: Date | null;
  deleted: boolean;
}

export interface CourseNoteEntry {
  id: string;
  lessonId: string;
  lessonTitle: string;
  lessonSlug: string;
  body: string;
  updatedAt: Date;
}

export type LessonNoteRow = LessonNote;
