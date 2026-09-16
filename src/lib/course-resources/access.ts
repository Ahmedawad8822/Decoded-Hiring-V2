import { hasLearnerAccess } from "@/features/enrollments/access";
import type { Enrollment } from "@/lib/db";

// ============================================================================
// LESSON-RESOURCE DOWNLOAD AUTHORIZATION (protected R2 objects)
// ----------------------------------------------------------------------------
// Single shared authorization predicate for the lesson-resource download
// route — exported from a LIB module (NOT from the route file, because Next
// typed-routes generation rejects non-HTTP exports on route modules) so the
// security-hardening regression suite can assert the exact verdict matrix.
//
// ADMIN:
//  - authenticated admin may retrieve lesson resources for authoring/review,
//    including draft-lesson resources (the lesson status check is skipped).
//
// NON-ADMIN:
//  - must have active/completed enrollment in the resource's course;
//  - the associated lesson MUST be published — draft/unpublished/archived
//    lessons answer "not-found" (404) so unpublished resources never leak
//    existence, exactly as before.
//
// NEVER weaken learner access: the learner path keeps every existing gate.
// ============================================================================

export type LessonResourceAccess =
  | { status: "allowed" }
  | { status: "not-found" }
  | { status: "forbidden" };

export function resolveLessonResourceAccess(opts: {
  role: string | null | undefined;
  /** null when the lesson row does not exist. */
  lessonStatus: string | null;
  enrollment: Enrollment | null;
}): LessonResourceAccess {
  if (opts.role === "admin") return { status: "allowed" };
  if (!opts.lessonStatus || opts.lessonStatus !== "published") {
    return { status: "not-found" };
  }
  // SECURITY (review correction C): cancelled enrollments download nothing —
  // same 403 as strangers, so revocation is real on every boundary.
  if (!hasLearnerAccess(opts.enrollment)) return { status: "forbidden" };
  return { status: "allowed" };
}