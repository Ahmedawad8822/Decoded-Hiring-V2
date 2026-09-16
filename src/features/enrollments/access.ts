import type { Enrollment } from "@/lib/db";

// ============================================================================
// LEARNER ACCESS RULE (Mission 06 review correction — single source of truth)
// ----------------------------------------------------------------------------
// One narrow shared authorization rule for learner access. Active and
// completed enrollments grant access; cancelled enrollments grant NOTHING:
// no protected lesson content, no resource downloads, no progress writes.
// Every boundary (lesson pages, resource download, markLessonComplete,
// requireEnrollment) uses hasLearnerAccess — never a local status check.
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
