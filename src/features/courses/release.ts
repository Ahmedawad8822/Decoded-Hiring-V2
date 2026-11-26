import type { CourseSection, Lesson } from "@/lib/db";

// ============================================================================
// DRIP RELEASE (Batch J)
// ----------------------------------------------------------------------------
// Pure maths for scheduled lesson availability. Each section AND each lesson
// carries its own release rule; the effective release instant is the LATER of
// the two (the stricter gate wins):
//   - 'immediate' -> released now (no constraint)
//   - 'date'      -> released at `release_at` (UTC instant)
//   - 'drip'      -> released `drip_days` after the enrollment's `enrolled_at`
//                    (UTC millisecond arithmetic: enrolledAt + days*86400_000)
//
// `enrolledAt` is the row's ORIGINAL enrollment instant: re-enrolment
// reactivates the same row and never resets it (see enrollments service), so
// drip always counts from the learner's first start.
//
// Preview lessons are ALWAYS released (free marketing surface). Admins bypass
// drip at every call site (never pass an enrollment for an admin read).
// ============================================================================

export type ReleaseRule = Pick<CourseSection, "releaseMode" | "releaseAt" | "dripDays">;
export type ReleasableLesson = Pick<
  Lesson,
  "releaseMode" | "releaseAt" | "dripDays" | "isPreview"
>;

const DAY_MS = 86_400_000;

function ruleReleaseAt(
  rule: Pick<ReleaseRule, "releaseMode" | "releaseAt" | "dripDays">,
  enrolledAt: Date,
): Date | null {
  if (rule.releaseMode === "date") {
    return rule.releaseAt ? new Date(rule.releaseAt.getTime()) : null;
  }
  if (rule.releaseMode === "drip") {
    const days = rule.dripDays ?? 0;
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) return null;
    return new Date(enrolledAt.getTime() + days * DAY_MS);
  }
  return null;
}

/**
 * Effective release instant for one (section, lesson) pair, or null when the
 * lesson is released right now. Pure: no I/O. Preview lessons always return
 * null regardless of rules.
 */
export function lessonReleaseAt(
  section: ReleaseRule | null | undefined,
  lesson: ReleasableLesson,
  enrolledAt: Date,
): Date | null {
  if (lesson.isPreview) return null;
  const candidates = [
    ruleReleaseAt(lesson, enrolledAt),
    section ? ruleReleaseAt(section, enrolledAt) : null,
  ].filter((d): d is Date => d !== null);
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

/** True when the lesson is available to the enrollment at `now`. */
export function isLessonReleased(
  section: ReleaseRule | null | undefined,
  lesson: ReleasableLesson,
  enrolledAt: Date,
  now: Date = new Date(),
): boolean {
  const at = lessonReleaseAt(section, lesson, enrolledAt);
  return at === null || at.getTime() <= now.getTime();
}

// ============================================================================
// SEQUENTIAL LOCK (learner polish)
// ----------------------------------------------------------------------------
// When a course has `sequential` on, a lesson is locked until every EARLIER
// required lesson (course order: section position, then lesson position) is
// complete. Optional earlier lessons never block. Free-preview lessons stay
// readable regardless (matching the drip rule that previews are always open).
// Drip and sequential combine: both must allow. Pure: no I/O. Callers pass
// published lessons already in course order.
// ============================================================================

export type SequentialLesson = Pick<Lesson, "id" | "required" | "isPreview">;

/**
 * First earlier required lesson that is still incomplete, or null when the
 * target is open. The returned id doubles as the "continue here" link target.
 */
export function findSequentialBlocker(
  orderedLessons: SequentialLesson[],
  completedLessonIds: Set<string> | Iterable<string>,
  lessonId: string,
): string | null {
  const done = completedLessonIds instanceof Set ? completedLessonIds : new Set(completedLessonIds);
  const idx = orderedLessons.findIndex((l) => l.id === lessonId);
  if (idx < 0) return null;
  if (orderedLessons[idx].isPreview) return null;
  for (let i = 0; i < idx; i++) {
    const earlier = orderedLessons[i];
    if (earlier.required && !done.has(earlier.id)) return earlier.id;
  }
  return null;
}

/** True when the sequential rule alone would lock this lesson. */
export function isSequentiallyLocked(
  orderedLessons: SequentialLesson[],
  completedLessonIds: Set<string> | Iterable<string>,
  lessonId: string,
): boolean {
  return findSequentialBlocker(orderedLessons, completedLessonIds, lessonId) !== null;
}

/**
 * Earliest future release instant among incomplete lessons, or null when
 * nothing pending is scheduled. Used for "Next lesson unlocks on <date>".
 */
export function nextReleaseAt(
  entries: Array<{ id: string; section: ReleaseRule | null; lesson: ReleasableLesson }>,
  enrolledAt: Date,
  completedLessonIds: Set<string> | Iterable<string>,
  now: Date = new Date(),
): Date | null {
  const done = completedLessonIds instanceof Set ? completedLessonIds : new Set(completedLessonIds);
  let earliest: Date | null = null;
  for (const entry of entries) {
    if (done.has(entry.id)) continue;
    const at = lessonReleaseAt(entry.section, entry.lesson, enrolledAt);
    if (at && at.getTime() > now.getTime() && (!earliest || at.getTime() < earliest.getTime())) {
      earliest = at;
    }
  }
  return earliest;
}
