import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  getDb,
  courses,
  courseSections,
  emailOutbox,
  enrollments,
  lessons,
  users,
  type Course,
  type Enrollment,
} from "@/lib/db";
import { getD1Database } from "@/lib/cloudflare/bindings";
import { getSiteUrl } from "@/lib/seo";
import { enqueueEmail, redactEmails } from "@/lib/email/outbox";
import { isEmailEnabled } from "@/lib/email/config";
import { getNudgeOptOuts, signUnsubscribeToken } from "@/lib/email/preferences";
import {
  lessonUnlockedTemplate,
  nudgeCompletedTemplate,
  nudgeInactiveTemplate,
  nudgeQuizFailedTemplate,
} from "@/lib/email/templates";
import { lessonReleaseAt } from "@/features/courses/release";

// ============================================================================
// LEARNER AUTOMATIONS (Batch J — drip unlock emails + three fixed nudges)
// ----------------------------------------------------------------------------
// Single entry `runLearnerAutomations({ now, limit })`. Every course toggle is
// OFF by default; cancelled enrollments, opted-out learners and a disabled
// email backend are always skipped (no backlog while email is off). Idempotent
// reruns via outbox `dedupeKey` (UNIQUE + onConflictDoNothing): firing twice
// enqueues once. Bounded: at most `limit` (default 50) emails per run and at
// most ~4 indexed queries per rule — no per-enrollment query loops.
// ============================================================================

export interface AutomationCounts {
  unlocked: number;
  completed: number;
  inactive: number;
  quizFailed: number;
  enqueued: number;
}

const ZERO: AutomationCounts = { unlocked: 0, completed: 0, inactive: 0, quizFailed: 0, enqueued: 0 };

/**
 * Shared per-run budget. Rules check `remaining()` before each candidate and
 * call `spend()` after each successful enqueue, so the limit is enforced
 * WITHIN a rule — not just between rules.
 */
export interface AutomationBudget {
  remaining: () => number;
  spend: () => void;
}

function siteBase(): string {
  return getSiteUrl().toString().replace(/\/$/, "");
}

function coachingUrlFor(course: Pick<Course, "coachingPath">): string {
  const base = siteBase();
  const path = (course.coachingPath ?? "").trim();
  if (path.startsWith("/") && !path.startsWith("//") && path.length <= 200 && !path.includes(" ")) {
    return `${base}${path}`;
  }
  return `${base}/contact`;
}

async function unsubscribeUrlFor(userId: string): Promise<string> {
  return `${siteBase()}/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${await signUnsubscribeToken(userId)}`;
}

const tokenCache = new Map<string, string>();
async function cachedUnsubscribeUrl(userId: string): Promise<string> {
  const hit = tokenCache.get(userId);
  if (hit) return hit;
  const url = await unsubscribeUrlFor(userId);
  tokenCache.set(userId, url);
  return url;
}

interface Recipient {
  id: string;
  name: string;
  email: string;
}

async function lookupRecipients(userIds: string[]): Promise<Map<string, Recipient>> {
  const out = new Map<string, Recipient>();
  if (userIds.length === 0) return out;
  const db = await getDb();
  for (let i = 0; i < userIds.length; i += 90) {
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds.slice(i, i + 90)));
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

/**
 * Dedupe pre-check: which of these dedupeKeys already have an outbox row?
 * enqueueEmail's onConflictDoNothing is the backstop; this keeps the reported
 * counts truthful (a rerun reports zero new emails) without extra per-row
 * queries — one chunked indexed lookup per rule.
 */
async function existingDedupeKeys(keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (keys.length === 0) return out;
  const db = await getDb();
  for (let i = 0; i < keys.length; i += 90) {
    const rows = await db
      .select({ dedupeKey: emailOutbox.dedupeKey })
      .from(emailOutbox)
      .where(inArray(emailOutbox.dedupeKey, keys.slice(i, i + 90)));
    for (const row of rows) {
      if (row.dedupeKey) out.add(row.dedupeKey);
    }
  }
  return out;
}

// ---------------------------------------------------------------- lesson_unlocked

async function runUnlockRule(
  now: Date,
  budget: AutomationBudget,
): Promise<{ unlocked: number; enqueued: number }> {
  const db = await getDb();
  const counts = { unlocked: 0, enqueued: 0 };
  // 1. Courses with the toggle on.
  const enabledCourses = await db.select().from(courses).where(eq(courses.notifyUnlocks, true));
  if (enabledCourses.length === 0) return counts;
  const courseMap = new Map(enabledCourses.map((c) => [c.id, c]));
  const courseIds = [...courseMap.keys()];

  // 2. Active enrollments in those courses (cancelled excluded by status).
  const activeEnrollments: Enrollment[] = [];
  for (let i = 0; i < courseIds.length; i += 90) {
    activeEnrollments.push(
      ...(await db
        .select()
        .from(enrollments)
        .where(and(inArray(enrollments.courseId, courseIds.slice(i, i + 90)), eq(enrollments.status, "active")))),
    );
  }
  if (activeEnrollments.length === 0) return counts;

  // 3. Release-bearing curriculum (sections feed the effective time; published
  // lessons with a non-immediate rule are the emailed items).
  const sectionRows = await db.select().from(courseSections).where(inArray(courseSections.courseId, courseIds));
  const allLessons = await db.select().from(lessons).where(inArray(lessons.courseId, courseIds));
  const sectionById = new Map(sectionRows.map((s) => [s.id, s]));
  const ruleLessons = allLessons.filter((l) => l.releaseMode !== "immediate" && l.status === "published");
  if (ruleLessons.length === 0) return counts;

  const windowStart = now.getTime() - 26 * 3_600_000;
  const windowEnd = now.getTime();
  type Candidate = { enrollment: Enrollment; lesson: (typeof ruleLessons)[number] };
  const candidates: Candidate[] = [];
  for (const enrollment of activeEnrollments) {
    if (budget.remaining() <= 0 || candidates.length >= budget.remaining() * 2) break;
    for (const lesson of ruleLessons) {
      if (lesson.courseId !== enrollment.courseId) continue;
      const at = lessonReleaseAt(sectionById.get(lesson.sectionId) ?? null, lesson, enrollment.enrolledAt);
      if (at && at.getTime() > windowStart && at.getTime() <= windowEnd) {
        candidates.push({ enrollment, lesson });
        if (candidates.length >= budget.remaining() * 2) break;
      }
    }
  }
  if (candidates.length === 0) return counts;

  // 4. One bounded user lookup + one opt-out check, then enqueue (deduped).
  const recipients = await lookupRecipients([...new Set(candidates.map((c) => c.enrollment.userId))]);
  const optOuts = await getNudgeOptOuts([...recipients.keys()]);
  const seen = await existingDedupeKeys(
    candidates.map(({ enrollment, lesson }) => `unlock:${enrollment.id}:${lesson.id}`),
  );
  for (const { enrollment, lesson } of candidates) {
    if (budget.remaining() <= 0) break;
    if (optOuts.has(enrollment.userId)) continue;
    if (seen.has(`unlock:${enrollment.id}:${lesson.id}`)) continue;
    const recipient = recipients.get(enrollment.userId);
    const course = courseMap.get(enrollment.courseId);
    if (!recipient || !course) continue;
    try {
      const template = lessonUnlockedTemplate({
        userName: recipient.name,
        courseTitle: course.title,
        lessonTitle: lesson.title,
        lessonUrl: `${siteBase()}/learn/courses/${course.slug}/lessons/${lesson.slug}`,
        unsubscribeUrl: await cachedUnsubscribeUrl(recipient.id),
      });
      await enqueueEmail({
        kind: "lesson_unlocked",
        toAddress: recipient.email,
        subject: template.subject,
        textBody: template.text,
        htmlBody: template.html,
        dedupeKey: `unlock:${enrollment.id}:${lesson.id}`,
        now,
      });
      counts.unlocked += 1;
      counts.enqueued += 1;
      budget.spend();
    } catch (error) {
      console.error("[automations] lesson_unlocked failed:", redactEmails(error instanceof Error ? error.message : String(error)));
    }
  }
  return counts;
}

// ---------------------------------------------------------------- nudge_completed

async function runCompletedRule(
  now: Date,
  budget: AutomationBudget,
): Promise<{ completed: number; enqueued: number }> {
  const db = await getDb();
  const counts = { completed: 0, enqueued: 0 };
  const enabledCourses = await db.select().from(courses).where(eq(courses.nudgeCompleted, true));
  if (enabledCourses.length === 0 || budget.remaining() <= 0) return counts;
  const courseMap = new Map(enabledCourses.map((c) => [c.id, c]));
  const courseIds = [...courseMap.keys()];

  const since = new Date(now.getTime() - 72 * 3_600_000);
  const recent: Enrollment[] = [];
  for (let i = 0; i < courseIds.length; i += 90) {
    recent.push(
      ...(await db
        .select()
        .from(enrollments)
        .where(
          and(
            inArray(enrollments.courseId, courseIds.slice(i, i + 90)),
            eq(enrollments.status, "completed"),
            gte(enrollments.completedAt, since),
            lte(enrollments.completedAt, now),
          ),
        )),
    );
  }
  if (recent.length === 0) return counts;

  const recipients = await lookupRecipients([...new Set(recent.map((e) => e.userId))]);
  const optOuts = await getNudgeOptOuts([...recipients.keys()]);
  const seen = await existingDedupeKeys(recent.map((e) => `nudge_completed:${e.id}`));
  for (const enrollment of recent) {
    if (budget.remaining() <= 0) break;
    if (optOuts.has(enrollment.userId)) continue;
    if (seen.has(`nudge_completed:${enrollment.id}`)) continue;
    const recipient = recipients.get(enrollment.userId);
    const course = courseMap.get(enrollment.courseId);
    if (!recipient || !course) continue;
    try {
      const template = nudgeCompletedTemplate({
        userName: recipient.name,
        courseTitle: course.title,
        coachingUrl: coachingUrlFor(course),
        unsubscribeUrl: await cachedUnsubscribeUrl(recipient.id),
      });
      await enqueueEmail({
        kind: "nudge_completed",
        toAddress: recipient.email,
        subject: template.subject,
        textBody: template.text,
        htmlBody: template.html,
        dedupeKey: `nudge_completed:${enrollment.id}`,
        now,
      });
      counts.completed += 1;
      counts.enqueued += 1;
      budget.spend();
    } catch (error) {
      console.error("[automations] nudge_completed failed:", redactEmails(error instanceof Error ? error.message : String(error)));
    }
  }
  return counts;
}

// ---------------------------------------------------------------- nudge_inactive
//
// lastActivityAt = Batch H rule: MAX(enrolled_at, latest lesson completion,
// latest quiz attempt). Candidates: active, idle between 7 and 8 days.

interface InactiveRow {
  enrollmentId: string;
  userId: string;
  courseSlug: string;
  courseTitle: string;
  coachingPath: string | null;
  lastActivitySec: number;
}

async function runInactiveRule(
  now: Date,
  budget: AutomationBudget,
): Promise<{ inactive: number; enqueued: number }> {
  const counts = { inactive: 0, enqueued: 0 };
  if (budget.remaining() <= 0) return counts;
  const d1 = await getD1Database();
  const nowSec = Math.floor(now.getTime() / 1000);
  // One indexed statement: toggle + status filter, opt-outs excluded inline,
  // correlated activity subqueries over indexed keys. The 7–8 day window is
  // applied in SQL via a derived table (so LIMIT never drops in-window rows)
  // and re-checked in memory.
  const { results } = await d1
    .prepare(
      `SELECT * FROM (SELECT e.id AS enrollmentId, e.user_id AS userId,
              c.slug AS courseSlug, c.title AS courseTitle, c.coaching_path AS coachingPath,
              MAX(e.enrolled_at,
                  COALESCE((SELECT MAX(completed_at) FROM lesson_progress WHERE enrollment_id = e.id), e.enrolled_at),
                  COALESCE((SELECT MAX(created_at) FROM quiz_attempts WHERE enrollment_id = e.id), e.enrolled_at)
              ) AS lastActivitySec
         FROM enrollments e JOIN courses c ON c.id = e.course_id
        WHERE c.nudge_inactive = 1 AND e.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM email_preferences p WHERE p.user_id = e.user_id AND p.course_nudges = 0)
        ) WHERE lastActivitySec <= ? AND lastActivitySec > ?
        LIMIT 200`,
    )
    .bind(nowSec - 7 * 86400, nowSec - 8 * 86400)
    .all<InactiveRow>();
  const candidates = results.filter(
    (r) => nowSec - r.lastActivitySec >= 7 * 86400 && nowSec - r.lastActivitySec < 8 * 86400,
  );
  if (candidates.length === 0) return counts;

  const recipients = await lookupRecipients([...new Set(candidates.map((c) => c.userId))]);
  const seen = await existingDedupeKeys(
    candidates.map((r) => `nudge_inactive:${r.enrollmentId}:${new Date(r.lastActivitySec * 1000).toISOString().slice(0, 10)}`),
  );
  for (const row of candidates) {
    if (budget.remaining() <= 0) break;
    const recipient = recipients.get(row.userId);
    if (!recipient) continue;
    const day = new Date(row.lastActivitySec * 1000).toISOString().slice(0, 10);
    if (seen.has(`nudge_inactive:${row.enrollmentId}:${day}`)) continue;
    try {
      const template = nudgeInactiveTemplate({
        userName: recipient.name,
        courseTitle: row.courseTitle,
        courseUrl: `${siteBase()}/learn/courses/${row.courseSlug}`,
        coachingUrl: coachingUrlFor({ coachingPath: row.coachingPath }),
        unsubscribeUrl: await cachedUnsubscribeUrl(recipient.id),
      });
      await enqueueEmail({
        kind: "nudge_inactive",
        toAddress: recipient.email,
        subject: template.subject,
        textBody: template.text,
        htmlBody: template.html,
        dedupeKey: `nudge_inactive:${row.enrollmentId}:${day}`,
        now,
      });
      counts.inactive += 1;
      counts.enqueued += 1;
      budget.spend();
    } catch (error) {
      console.error("[automations] nudge_inactive failed:", redactEmails(error instanceof Error ? error.message : String(error)));
    }
  }
  return counts;
}

// ---------------------------------------------------------------- nudge_quiz_failed

interface QuizFailRow {
  userId: string;
  quizId: string;
  courseSlug: string;
  courseTitle: string;
  coachingPath: string | null;
  lessonSlug: string;
  lessonTitle: string;
}

async function runQuizFailedRule(
  now: Date,
  budget: AutomationBudget,
): Promise<{ quizFailed: number; enqueued: number }> {
  const counts = { quizFailed: 0, enqueued: 0 };
  if (budget.remaining() <= 0) return counts;
  const d1 = await getD1Database();
  const sinceSec = Math.floor(now.getTime() / 1000) - 48 * 3600;
  // Users with >= 2 failed attempts on one quiz, no pass ever, latest failure
  // inside 48 h, on a toggled course, with a live (non-cancelled) enrollment.
  // Opt-outs are filtered inline (indexed user_id lookup).
  const { results } = await d1
    .prepare(
      `SELECT qa.user_id AS userId, qa.quiz_id AS quizId,
              c.slug AS courseSlug, c.title AS courseTitle, c.coaching_path AS coachingPath,
              l.slug AS lessonSlug, l.title AS lessonTitle
         FROM quiz_attempts qa
         JOIN lesson_quizzes lq ON lq.id = qa.quiz_id
         JOIN courses c ON c.id = lq.course_id
         JOIN lessons l ON l.id = qa.lesson_id
        WHERE c.nudge_quiz_failed = 1 AND qa.passed = 0
          AND NOT EXISTS (SELECT 1 FROM quiz_attempts p
                           WHERE p.quiz_id = qa.quiz_id AND p.user_id = qa.user_id AND p.passed = 1)
          AND EXISTS (SELECT 1 FROM enrollments e
                       WHERE e.user_id = qa.user_id AND e.course_id = lq.course_id
                         AND e.status IN ('active', 'completed'))
          AND NOT EXISTS (SELECT 1 FROM email_preferences p WHERE p.user_id = qa.user_id AND p.course_nudges = 0)
        GROUP BY qa.user_id, qa.quiz_id
        HAVING COUNT(*) >= 2 AND MAX(qa.created_at) >= ?
        LIMIT 200`,
    )
    .bind(sinceSec)
    .all<QuizFailRow>();
  if (results.length === 0) return counts;

  const recipients = await lookupRecipients([...new Set(results.map((r) => r.userId))]);
  const seen = await existingDedupeKeys(results.map((r) => `nudge_quiz_failed:${r.userId}:${r.quizId}`));
  for (const row of results) {
    if (budget.remaining() <= 0) break;
    const recipient = recipients.get(row.userId);
    if (!recipient) continue;
    if (seen.has(`nudge_quiz_failed:${row.userId}:${row.quizId}`)) continue;
    try {
      const template = nudgeQuizFailedTemplate({
        userName: recipient.name,
        courseTitle: row.courseTitle,
        lessonTitle: row.lessonTitle,
        quizUrl: `${siteBase()}/learn/courses/${row.courseSlug}/lessons/${row.lessonSlug}`,
        coachingUrl: coachingUrlFor({ coachingPath: row.coachingPath }),
        unsubscribeUrl: await cachedUnsubscribeUrl(recipient.id),
      });
      await enqueueEmail({
        kind: "nudge_quiz_failed",
        toAddress: recipient.email,
        subject: template.subject,
        textBody: template.text,
        htmlBody: template.html,
        dedupeKey: `nudge_quiz_failed:${row.userId}:${row.quizId}`,
        now,
      });
      counts.quizFailed += 1;
      counts.enqueued += 1;
      budget.spend();
    } catch (error) {
      console.error("[automations] nudge_quiz_failed failed:", redactEmails(error instanceof Error ? error.message : String(error)));
    }
  }
  return counts;
}

// ---------------------------------------------------------------- entry

/**
 * Pure hourly gate for the cron trigger (unit-testable): the 5-minute cron
 * fires worker scheduled() every 5 minutes; automations run only when the
 * scheduled minute is < 5, i.e. roughly once an hour.
 */
export function shouldRunLearnerAutomations(scheduledTime: Date): boolean {
  return scheduledTime.getUTCMinutes() < 5;
}

export async function runLearnerAutomations(
  options: { now?: Date; limit?: number } = {},
): Promise<AutomationCounts> {
  // Skip everything while email is off: no backlog accrues, nothing enqueues.
  if (!isEmailEnabled()) return { ...ZERO };
  tokenCache.clear();
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
  let used = 0;
  const budget: AutomationBudget = {
    remaining: () => limit - used,
    spend: () => {
      used += 1;
    },
  };
  const counts: AutomationCounts = { ...ZERO };

  const commit = (part: { unlocked?: number; completed?: number; inactive?: number; quizFailed?: number; enqueued?: number }) => {
    counts.unlocked += part.unlocked ?? 0;
    counts.completed += part.completed ?? 0;
    counts.inactive += part.inactive ?? 0;
    counts.quizFailed += part.quizFailed ?? 0;
    counts.enqueued += part.enqueued ?? 0;
  };

  commit(await runUnlockRule(now, budget));
  if (budget.remaining() > 0) commit(await runCompletedRule(now, budget));
  if (budget.remaining() > 0) commit(await runInactiveRule(now, budget));
  if (budget.remaining() > 0) commit(await runQuizFailedRule(now, budget));
  return counts;
}
