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

export const createCourseSchema = z.object({
  title: z.string().trim().min(3, "Title must be at least 3 characters").max(160),
  slug: slugSchema,
  description: z.string().trim().max(2000).optional().nullable(),
  accessMode: courseAccessModeSchema.optional().default("FREE"),
  coverImage: coverImageSchema,
});

export const updateCourseSchema = z.object({
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
  courseId: z.string().min(1),
  sectionId: z.string().min(1),
  title: z.string().trim().min(3, "Lesson title must be at least 3 characters").max(160),
  slug: slugSchema,
  body: contentBlocksArraySchema.optional().default([]),
  videoUrl: z.string().trim().max(500).optional().nullable(),
  required: z.boolean().optional().default(true),
});

export const updateLessonSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(3).max(160).optional(),
  slug: slugSchema.optional(),
  body: contentBlocksArraySchema.optional(),
  videoUrl: z.string().trim().max(500).optional().nullable(),
  required: z.boolean().optional(),
});

export type CreateCourseInput = z.infer<typeof createCourseSchema>;
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;
export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type CreateLessonInput = z.infer<typeof createLessonSchema>;
export type UpdateLessonInput = z.infer<typeof updateLessonSchema>;
