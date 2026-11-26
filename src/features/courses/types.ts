import { z } from "zod";
import {
  contentBlocksArraySchema,
  coverImageSchema,
  slugSchema,
} from "@/features/publishing/types";

// ============================================================================
// COURSES DOMAIN TYPES (Mission 06)
// ----------------------------------------------------------------------------
// Course lifecycle: draft -> published -> archived (archived is terminal for
// new enrollments; existing learners retain access).
// Access modes are provider-neutral; only FREE auto-enrolls in Mission 06.
// ============================================================================

export const courseStatusSchema = z.union([
  z.literal("draft"),
  z.literal("published"),
  z.literal("archived"),
]);

export const courseAccessModeSchema = z.union([
  z.literal("FREE"),
  z.literal("PAID_ONE_TIME"),
  z.literal("MANUAL_INVOICE"),
  z.literal("PAYMENT_DISABLED"),
]);

export const lessonStatusSchema = z.union([
  z.literal("draft"),
  z.literal("published"),
  z.literal("archived"),
]);

// ---------------------------------------------------------------- Batch J drip release

export const releaseModeSchema = z.union([
  z.literal("immediate"),
  z.literal("date"),
  z.literal("drip"),
]);

const releaseFields = {
  releaseMode: releaseModeSchema,
  /** ISO UTC instant (admin sends local datetime-local converted to ISO). */
  releaseAt: z.string().trim().max(64).optional().nullable(),
  dripDays: z.number().int().min(1).max(365).optional().nullable(),
};

function refineRelease<T extends { releaseMode: string; releaseAt?: string | null; dripDays?: number | null }>(
  schema: z.ZodType<T>,
) {
  return schema.superRefine((value, ctx) => {
    if (value.releaseMode === "date" && !value.releaseAt) {
      ctx.addIssue({ code: "custom", message: "A release date is required for 'On a date'." });
    }
    if (value.releaseMode === "date" && value.releaseAt) {
      const parsed = new Date(value.releaseAt);
      if (Number.isNaN(parsed.getTime())) {
        ctx.addIssue({ code: "custom", message: "Release date must be a valid date." });
      }
    }
    if (value.releaseMode === "drip" && (value.dripDays === null || value.dripDays === undefined)) {
      ctx.addIssue({ code: "custom", message: "Days after enrolling is required for drip (1–365)." });
    }
  });
}

export const sectionReleaseSchema = refineRelease(
  z.object({ id: z.string().min(1), ...releaseFields }),
);

export const lessonReleaseSchema = refineRelease(
  z.object({ id: z.string().min(1), ...releaseFields }),
);

export type SectionReleaseInput = z.input<typeof sectionReleaseSchema>;
export type LessonReleaseInput = z.input<typeof lessonReleaseSchema>;

export const outcomesSchema = z.array(z.string().trim().min(1).max(200)).max(12);
export const faqSchema = z.array(z.object({
  q: z.string().trim().min(1).max(200),
  a: z.string().trim().min(1).max(1500),
})).max(12);
const courseLandingFields = {
  certificateEnabled: z.boolean().optional(),
  outcomes: outcomesSchema.optional().nullable(),
  audience: z.string().trim().max(2000).optional().nullable(),
  faq: faqSchema.optional().nullable(),
  instructorName: z.string().trim().max(160).optional().nullable(),
  instructorBio: z.string().trim().max(1500).optional().nullable(),
  // Learner polish: lock each lesson until every earlier required lesson is
  // complete (course order). Previews stay readable. OFF by default.
  sequential: z.boolean().optional(),
  // Batch J learner automations (all OFF by default; Studio course settings).
  notifyUnlocks: z.boolean().optional(),
  nudgeCompleted: z.boolean().optional(),
  nudgeInactive: z.boolean().optional(),
  nudgeQuizFailed: z.boolean().optional(),
  coachingPath: z
    .string()
    .trim()
    .max(200)
    .refine(
      (v) => v === "" || (v.startsWith("/") && !v.startsWith("//") && !v.includes(" ")),
      { message: "Coaching link must be a same-site path starting with / (no //, max 200 chars)." },
    )
    .optional()
    .nullable(),
};
const lessonMetadataFields = {
  isPreview: z.boolean().optional(),
  durationMinutes: z.number().int().min(1).max(600).optional().nullable(),
};

export const createCourseSchema = z.object({
  ...courseLandingFields,
  title: z.string().trim().min(3, "Title must be at least 3 characters").max(160),
  slug: slugSchema,
  description: z.string().trim().max(2000).optional().nullable(),
  accessMode: courseAccessModeSchema.optional().default("FREE"),
  coverImage: coverImageSchema,
});

export const updateCourseSchema = z.object({
  ...courseLandingFields,
  id: z.string().min(1),
  title: z.string().trim().min(3).max(160).optional(),
  slug: slugSchema.optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  accessMode: courseAccessModeSchema.optional(),
  coverImage: coverImageSchema,
});

export const createSectionSchema = z.object({
  courseId: z.string().min(1),
  title: z.string().trim().min(1, "Section title is required").max(160),
});

export const renameSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1, "Section title is required").max(160),
});

export const createLessonSchema = z.object({
  ...lessonMetadataFields,
  courseId: z.string().min(1),
  sectionId: z.string().min(1),
  title: z.string().trim().min(3, "Lesson title must be at least 3 characters").max(160),
  slug: slugSchema,
  body: contentBlocksArraySchema.optional().default([]),
  videoUrl: z.string().trim().max(500).optional().nullable(),
  required: z.boolean().optional().default(true),
});

export const updateLessonSchema = z.object({
  ...lessonMetadataFields,
  id: z.string().min(1),
  title: z.string().trim().min(3).max(160).optional(),
  slug: slugSchema.optional(),
  body: contentBlocksArraySchema.optional(),
  videoUrl: z.string().trim().max(500).optional().nullable(),
  required: z.boolean().optional(),
});

export type CreateCourseInput = z.input<typeof createCourseSchema>;
export type UpdateCourseInput = z.input<typeof updateCourseSchema>;
export type CreateSectionInput = z.input<typeof createSectionSchema>;
export type CreateLessonInput = z.input<typeof createLessonSchema>;
export type UpdateLessonInput = z.input<typeof updateLessonSchema>;
