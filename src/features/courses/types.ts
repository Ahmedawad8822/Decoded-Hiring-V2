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
