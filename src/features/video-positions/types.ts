import { z } from "zod";

// ============================================================================
// VIDEO POSITION INPUTS (learner polish: resume + 90% auto-complete)
// ----------------------------------------------------------------------------
// Numbers are validated server-side: finite, within a 24 h cap, and the
// position may not run past the known duration (plus a small tolerance for
// player rounding). Ownership is resolved server-side — the caller never
// supplies a user id.
// ============================================================================

/** Longest trackable video: 24 h in seconds. */
export const MAX_VIDEO_SECONDS = 86_400;

/** Player rounding tolerance when the position slightly exceeds duration. */
export const POSITION_OVERHANG_TOLERANCE_SECONDS = 2;

export const saveVideoPositionSchema = z
  .object({
    courseSlug: z.string().trim().min(1, "Course is required.").max(200),
    lessonSlug: z.string().trim().min(1, "Lesson is required.").max(200),
    positionSeconds: z
      .number({ error: "Position must be a number." })
      .finite("Position must be a number.")
      .min(0, "Position must not be negative.")
      .max(MAX_VIDEO_SECONDS, "Position is too large."),
    durationSeconds: z
      .number({ error: "Duration must be a number." })
      .finite("Duration must be a number.")
      .positive("Duration must be positive.")
      .max(MAX_VIDEO_SECONDS, "Duration is too large.")
      .nullable()
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.durationSeconds != null &&
      value.positionSeconds > value.durationSeconds + POSITION_OVERHANG_TOLERANCE_SECONDS
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Position must not run past the video duration.",
      });
    }
  });

export type SaveVideoPositionInput = z.input<typeof saveVideoPositionSchema>;

/** Fraction watched that marks a lesson complete through the normal path. */
export const AUTO_COMPLETE_FRACTION = 0.9;
