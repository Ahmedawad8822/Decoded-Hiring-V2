import { and, asc, desc, eq, gte, ne, sql } from "drizzle-orm";
import {
  courseSections,
  courses,
  getDb,
  lessonQuestions,
  lessons,
  users,
  type Course,
  type Enrollment,
  type Lesson,
  type LessonQuestion,
} from "@/lib/db";
import { getLearnerCourseBySlug, getPublishedLessonBySlug } from "@/features/courses/service";
import { getLessonReadAccess } from "@/features/courses/lesson-access";
import { isLessonReleased } from "@/features/courses/release";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { AppError } from "@/lib/errors";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { notifyQuestionAnswered } from "@/lib/email/triggers";
import {
  answerQuestionSchema,
  askQuestionSchema,
  isLessonQuestionStatus,
  PUBLIC_QUESTIONS_LIMIT,
  QUESTIONS_PAGE_SIZE,
  QUESTIONS_PER_DAY,
  type AdminQuestionRow,
  type AnswerQuestionInput,
  type AskQuestionInput,
  type LessonQuestionStatus,
  type PublicLessonQuestion,
} from "./types";

// ============================================================================
// LESSON QUESTIONS SERVICE
// ----------------------------------------------------------------------------
// SECURITY BOUNDARIES:
// - Learner reads are owner-scoped (user_id) or the identity-free public
//   projection (answered + public only, no user columns selected).
// - Writes require an ACTIVE/COMPLETED enrollment on a published lesson of a
//   live course; drip-locked lessons refuse. Free-preview readers cannot ask.
// - Leaving a course keeps the rows (matches the leave-course policy); the
//   enrollment gate hides them until re-enrollment.
// Query budget (Workers Free, 10 ms CPU): indexed single-statement reads,
// paginated inbox, at most one count per ask for the daily budget.
// ============================================================================

function newQuestionId(): string {
  return `lq_${crypto.randomUUID().slice(0, 12)}`;
}

interface AuthorizedLesson {
  course: Course;
  lesson: Lesson;
  enrollment: Enrollment;
}

/**
 * Write authorization: signed-in (caller guarantees), active/completed
 * enrollment, published lesson the shared read gate calls "enrolled", lesson
 * belongs to the course in the URL, and the lesson is released (drip).
 */
async function requireEnrolledLesson(
  userId: string,
  courseSlug: string,
  lessonSlug: string,
  action: "ask" | "delete",
): Promise<AuthorizedLesson> {
  const course = await getLearnerCourseBySlug(courseSlug, userId);
  if (!course) throw new AppError("not_found", "Course not found.");

  const lesson = await getPublishedLessonBySlug(course.id, lessonSlug);
  if (!lesson) throw new AppError("not_found", "Lesson not found.");
  if (lesson.courseId !== course.id) throw new AppError("not_found", "Lesson not found.");

  const enrollment = await getEnrollment(userId, course.id);
  const activeEnrollment = hasLearnerAccess(enrollment) ? enrollment : null;
  const access = getLessonReadAccess({
    signedIn: true,
    enrolled: Boolean(activeEnrollment),
    course,
    lesson,
  });
  if (access !== "enrolled" || !activeEnrollment) {
    throw new AppError(
      "forbidden",
      `Enroll in this course to ${action} questions for this lesson.`,
    );
  }
  const db = await getDb();
  const section = await db
    .select()
    .from(courseSections)
    .where(eq(courseSections.id, lesson.sectionId))
    .get();
  if (!isLessonReleased(section ?? null, lesson, activeEnrollment.enrolledAt)) {
    throw new AppError("forbidden", "This lesson has not unlocked yet.");
  }

  return { course, lesson, enrollment: activeEnrollment };
}

/** Start of the current UTC day: the daily ask budget resets at midnight UTC. */
function startOfUtcDay(now: Date): Date {
  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/**
 * Ask the instructor a question on a lesson. Idempotent on the client key:
 * replaying the same key returns the original row; reusing a key with
 * different content is a conflict. The daily budget (10/learner/day) is
 * counted against the (user_id, created_at) index.
 */
export async function askLessonQuestion(
  userId: string,
  input: AskQuestionInput,
): Promise<LessonQuestion> {
  const parsed = askQuestionSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "invalid",
      parsed.error.issues.map((issue) => issue.message).join(", "),
    );
  }
  const { course, lesson } = await requireEnrolledLesson(
    userId,
    parsed.data.courseSlug,
    parsed.data.lessonSlug,
    "ask",
  );
  const db = await getDb();

  // Idempotency first: a retried submit must return the original row even
  // when the learner has since hit the daily budget.
  const findPrior = async (): Promise<LessonQuestion | null> => {
    const prior = await db
      .select()
      .from(lessonQuestions)
      .where(eq(lessonQuestions.idempotencyKey, parsed.data.idempotencyKey))
      .get();
    if (!prior) return null;
    if (prior.userId !== userId) {
      throw new AppError("conflict", "This submission was already sent. Please reload.");
    }
    if (prior.lessonId !== lesson.id || prior.body !== parsed.data.body) {
      throw new AppError("conflict", "This submission was already sent with different content.");
    }
    return prior;
  };
  const prior = await findPrior();
  if (prior) return prior;

  const now = new Date();
  const today = await db
    .select({ count: sql<number>`count(*)` })
    .from(lessonQuestions)
    .where(
      and(eq(lessonQuestions.userId, userId), gte(lessonQuestions.createdAt, startOfUtcDay(now))),
    )
    .get();
  if (Number(today?.count ?? 0) >= QUESTIONS_PER_DAY) {
    throw new AppError(
      "invalid",
      `You can ask up to ${QUESTIONS_PER_DAY} questions per day. Please try again tomorrow.`,
    );
  }

  const row: LessonQuestion = {
    id: newQuestionId(),
    lessonId: lesson.id,
    courseId: course.id,
    userId,
    body: parsed.data.body,
    status: "open",
    answerBody: null,
    answeredAt: null,
    answeredBy: null,
    isPublic: false,
    idempotencyKey: parsed.data.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(lessonQuestions).values(row);
  } catch (error) {
    // A concurrent submit with the same key won the insert: return its row.
    // (The daily budget is a soft cap; a race can admit one extra question.)
    if (!isUniqueConstraintError(error)) throw error;
    const winner = await findPrior();
    if (!winner) throw error;
    return winner;
  }
  return row;
}

/** Owner-scoped reads: cancelled enrollments keep rows but cannot read them. */
async function requireReadableEnrollment(userId: string, courseId: string): Promise<void> {
  const enrollment = await getEnrollment(userId, courseId);
  if (!hasLearnerAccess(enrollment)) {
    throw new AppError("forbidden", "Enroll in this course to see questions for this lesson.");
  }
}

/** The learner's own questions on one lesson, oldest first. */
export async function listMyLessonQuestions(
  userId: string,
  lessonId: string,
  courseId: string,
): Promise<LessonQuestion[]> {
  await requireReadableEnrollment(userId, courseId);
  const db = await getDb();
  return db
    .select()
    .from(lessonQuestions)
    .where(and(eq(lessonQuestions.userId, userId), eq(lessonQuestions.lessonId, lessonId)))
    .orderBy(asc(lessonQuestions.createdAt), asc(lessonQuestions.id));
}

/**
 * Identity-free public Q&A for a lesson: answered + published only, the
 * asker's own rows excluded (they render in "Your questions"). No user
 * column is selected, so no name or email can leak.
 */
export async function listPublicLessonQuestions(
  lessonId: string,
  excludeUserId: string | null,
): Promise<PublicLessonQuestion[]> {
  const db = await getDb();
  const conditions = [
    eq(lessonQuestions.lessonId, lessonId),
    eq(lessonQuestions.status, "answered"),
    eq(lessonQuestions.isPublic, true),
    ...(excludeUserId ? [ne(lessonQuestions.userId, excludeUserId)] : []),
  ];
  const rows = await db
    .select({
      id: lessonQuestions.id,
      userId: lessonQuestions.userId,
      body: lessonQuestions.body,
      answerBody: lessonQuestions.answerBody,
      answeredAt: lessonQuestions.answeredAt,
    })
    .from(lessonQuestions)
    .where(and(...conditions))
    .orderBy(asc(lessonQuestions.createdAt), asc(lessonQuestions.id))
    .limit(PUBLIC_QUESTIONS_LIMIT + 1);
  return rows
    .filter((row) => row.answerBody !== null && row.answeredAt !== null)
    .slice(0, PUBLIC_QUESTIONS_LIMIT)
    .map((row) => ({
      id: row.id,
      body: row.body,
      answerBody: row.answerBody as string,
      answeredAt: row.answeredAt as Date,
    }));
}

/** A learner can delete their own question while it is still open. */
export async function deleteMyLessonQuestion(
  userId: string,
  questionId: string,
): Promise<{ deleted: boolean }> {
  const db = await getDb();
  const existing = await db
    .select()
    .from(lessonQuestions)
    .where(eq(lessonQuestions.id, questionId))
    .get();
  if (!existing || existing.userId !== userId) {
    throw new AppError("not_found", "Question not found.");
  }
  if (existing.status !== "open") {
    throw new AppError("invalid", "Only open questions can be deleted.");
  }
  await db
    .delete(lessonQuestions)
    .where(and(eq(lessonQuestions.id, existing.id), eq(lessonQuestions.status, "open")));
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Studio inbox (admin-only; every caller is an admin action — requireAdmin
// runs in the action layer, mirroring leads/admin.ts which trusts it too).
// ---------------------------------------------------------------------------

export const QUESTION_TRANSITIONS: Record<LessonQuestionStatus, readonly LessonQuestionStatus[]> = {
  open: ["closed"],
  answered: ["closed"],
  closed: ["open"],
};

function mapAdminRow(row: {
  id: string;
  body: string;
  status: LessonQuestionStatus;
  answerBody: string | null;
  answeredAt: Date | null;
  answeredBy: string | null;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  learnerId: string;
  learnerName: string;
  learnerEmail: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  lessonId: string;
  lessonTitle: string;
  lessonSlug: string;
}): AdminQuestionRow {
  return row;
}

export async function listAdminQuestions(opts: {
  status?: string | null;
  courseId?: string | null;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: AdminQuestionRow[]; total: number; page: number; pageCount: number }> {
  const db = await getDb();
  const pageSize = opts.pageSize ?? QUESTIONS_PAGE_SIZE;
  const status = isLessonQuestionStatus(opts.status) ? opts.status : null;
  const conditions = [];
  if (status) conditions.push(eq(lessonQuestions.status, status));
  if (opts.courseId) conditions.push(eq(lessonQuestions.courseId, opts.courseId));
  const where = conditions.length ? and(...conditions) : undefined;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(lessonQuestions)
    .where(where);
  const pageCount = Math.max(1, Math.ceil(Number(total) / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);

  // Open first, then newest — so the default view is the triage queue.
  const orderBy = status
    ? [desc(lessonQuestions.createdAt), desc(lessonQuestions.id)]
    : [
        sql`case ${lessonQuestions.status} when 'open' then 0 when 'answered' then 1 else 2 end`,
        desc(lessonQuestions.createdAt),
        desc(lessonQuestions.id),
      ];

  const rows = await db
    .select({
      id: lessonQuestions.id,
      body: lessonQuestions.body,
      status: lessonQuestions.status,
      answerBody: lessonQuestions.answerBody,
      answeredAt: lessonQuestions.answeredAt,
      answeredBy: lessonQuestions.answeredBy,
      isPublic: lessonQuestions.isPublic,
      createdAt: lessonQuestions.createdAt,
      updatedAt: lessonQuestions.updatedAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      lessonSlug: lessons.slug,
    })
    .from(lessonQuestions)
    .innerJoin(users, eq(users.id, lessonQuestions.userId))
    .innerJoin(courses, eq(courses.id, lessonQuestions.courseId))
    .innerJoin(lessons, eq(lessons.id, lessonQuestions.lessonId))
    .where(where)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { rows: rows.map(mapAdminRow), total: Number(total), page, pageCount };
}

/** Courses that have at least one question (for the inbox course filter). */
export async function listQuestionCourses(): Promise<Array<{ id: string; title: string }>> {
  const db = await getDb();
  const rows = await db
    .selectDistinct({ id: courses.id, title: courses.title })
    .from(lessonQuestions)
    .innerJoin(courses, eq(courses.id, lessonQuestions.courseId))
    .orderBy(asc(courses.title));
  return rows;
}

/** Open-question count for the Studio nav badge and dashboard card. */
export async function countOpenQuestions(): Promise<number> {
  const db = await getDb();
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(lessonQuestions)
    .where(eq(lessonQuestions.status, "open"))
    .get();
  return Number(row?.count ?? 0);
}

export async function getAdminQuestion(id: string): Promise<AdminQuestionRow | null> {
  const db = await getDb();
  const row = await db
    .select({
      id: lessonQuestions.id,
      body: lessonQuestions.body,
      status: lessonQuestions.status,
      answerBody: lessonQuestions.answerBody,
      answeredAt: lessonQuestions.answeredAt,
      answeredBy: lessonQuestions.answeredBy,
      isPublic: lessonQuestions.isPublic,
      createdAt: lessonQuestions.createdAt,
      updatedAt: lessonQuestions.updatedAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      lessonSlug: lessons.slug,
    })
    .from(lessonQuestions)
    .innerJoin(users, eq(users.id, lessonQuestions.userId))
    .innerJoin(courses, eq(courses.id, lessonQuestions.courseId))
    .innerJoin(lessons, eq(lessons.id, lessonQuestions.lessonId))
    .where(eq(lessonQuestions.id, id))
    .get();
  return row ? mapAdminRow(row) : null;
}

/**
 * Answer a question (open or re-answer). Sets status=answered. The learner
 * notification email is queued with a per-question dedupe key, so editing an
 * answer later never sends a second email.
 */
export async function answerLessonQuestion(
  adminId: string,
  input: AnswerQuestionInput,
): Promise<AdminQuestionRow> {
  const parsed = answerQuestionSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "invalid",
      parsed.error.issues.map((issue) => issue.message).join(", "),
    );
  }
  const db = await getDb();
  const existing = await db
    .select()
    .from(lessonQuestions)
    .where(eq(lessonQuestions.id, parsed.data.id))
    .get();
  if (!existing) throw new AppError("not_found", "Question not found.");
  if (existing.status === "closed") {
    throw new AppError("invalid", "Reopen this question before answering it.");
  }

  const now = new Date();
  await db
    .update(lessonQuestions)
    .set({
      answerBody: parsed.data.answerBody,
      answeredAt: now,
      answeredBy: adminId,
      isPublic: parsed.data.isPublic,
      status: "answered",
      updatedAt: now,
    })
    .where(eq(lessonQuestions.id, existing.id));

  const updated = await getAdminQuestion(existing.id);
  if (!updated) throw new AppError("not_found", "Question not found.");
  // Never throws (failures stay in the log); dedupe keeps it to one email.
  await notifyQuestionAnswered({
    userId: existing.userId,
    courseTitle: updated.courseTitle,
    courseSlug: updated.courseSlug,
    lessonTitle: updated.lessonTitle,
    lessonSlug: updated.lessonSlug,
    questionId: existing.id,
  });
  return updated;
}

/**
 * Close (open/answered -> closed) or reopen (closed -> open). The UPDATE is
 * conditional on the expected status so a stale Studio tab cannot skip a
 * newer state.
 */
export async function transitionQuestionStatus(input: {
  id: string;
  from: LessonQuestionStatus;
  to: LessonQuestionStatus;
}): Promise<AdminQuestionRow> {
  if (!QUESTION_TRANSITIONS[input.from].includes(input.to)) {
    throw new AppError("invalid", `A question cannot move from ${input.from} to ${input.to}.`);
  }
  const db = await getDb();
  const updated = await db
    .update(lessonQuestions)
    .set({ status: input.to, updatedAt: new Date() })
    .where(and(eq(lessonQuestions.id, input.id), eq(lessonQuestions.status, input.from)))
    .returning({ id: lessonQuestions.id });
  if (updated.length === 0) {
    const existing = await getAdminQuestion(input.id);
    if (!existing) throw new AppError("not_found", "Question not found.");
    throw new AppError("conflict", `This question is now ${existing.status}; reload and try again.`);
  }
  const row = await getAdminQuestion(input.id);
  if (!row) throw new AppError("not_found", "Question not found.");
  return row;
}

// ---------------------------------------------------------------------------
// People profile (admin): the person's questions for the timeline.
// ---------------------------------------------------------------------------

export interface PersonQuestion {
  id: string;
  status: LessonQuestionStatus;
  lessonTitle: string;
  courseTitle: string;
  createdAt: Date;
}

/** Newest first, capped — merged into the profile timeline in memory. */
export async function listPersonQuestions(userId: string): Promise<PersonQuestion[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: lessonQuestions.id,
      status: lessonQuestions.status,
      createdAt: lessonQuestions.createdAt,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
    })
    .from(lessonQuestions)
    .innerJoin(lessons, eq(lessons.id, lessonQuestions.lessonId))
    .innerJoin(courses, eq(courses.id, lessonQuestions.courseId))
    .where(eq(lessonQuestions.userId, userId))
    .orderBy(desc(lessonQuestions.createdAt), desc(lessonQuestions.id))
    .limit(50);
  return rows;
}
