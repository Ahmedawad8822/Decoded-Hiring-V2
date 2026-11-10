import type { Enrollment } from "@/lib/db";

// ============================================================================
// LEARNER ACCESS RULE (Mission 06 review correction — single source of truth)
// ----------------------------------------------------------------------------
// Active and completed enrollments grant full learner access. Cancelled
// enrollments grant no entitlement, resource downloads or progress writes.
// Lesson reads separately allow published free previews for signed-in users
// through courses/lesson-access.ts; previews do not change this predicate.
// ============================================================================

export const LEARNER_ACCESS_STATUSES = ["active", "completed"] as const;

export type LearnerAccessStatus = (typeof LEARNER_ACCESS_STATUSES)[number];

/** True only for enrollments that currently grant learner access. */
export function hasLearnerAccess(
  enrollment: Enrollment | null | undefined
): enrollment is Enrollment {
  if (!enrollment) return false;
  return (
    enrollment.status === "active" || enrollment.status === "completed"
  );
}
