// ============================================================================
// PEOPLE SERVICE (Batch I — "Know your people")
// ----------------------------------------------------------------------------
// Admin-only reads over every durable trace a learner leaves: enrollments,
// quiz attempts, certificates, bookings (by requester email), orders (by user
// id or customer email), leads (by email) and sent emails. Every function
// calls requireAdmin(). Query budget is deliberately tiny (Workers Free):
//   - listPeople:                ONE SQL statement (aggregates + tags inline)
//   - listAllPeopleForExport:    ONE SQL statement
//   - getPersonProfile:          user lookup, then Promise.all of 9 bounded
//     section queries (Batch J adds the nudge-preference lookup); no per-row
//     loops; the timeline is merged in memory.
// lesson_notes are NEVER read here (learner-private by design) and email
// bodies are never selected (kind/subject/status/dates only).
// ============================================================================

import { requireAdmin } from "@/lib/auth";
import { getD1Database } from "@/lib/cloudflare/bindings";
import { getDb, adminPersonNotes, learnerTags, users } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { LEARNER_TAG_PATTERN } from "@/features/quizzes/types";

export const PEOPLE_PAGE_SIZE = 25;
export const PEOPLE_EXPORT_MAX_ROWS = 5000;
export const PERSON_NOTE_MAX_LENGTH = 5000;
const PROFILE_LIST_LIMIT = 50;
const PROFILE_ATTEMPT_LIMIT = 20;
const PROFILE_EMAIL_LIMIT = 20;

/** Trimmed search text, max 100 chars; empty string means "no search". */
export function parsePeopleQuery(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

/** Normalized tag filter (lowercase slug); empty string means "no filter". */
export function parsePeopleTag(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 100) : "";
}

export function parsePeoplePage(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) return 1;
  return Math.max(1, Math.min(10000, n));
}

export interface PersonRow {
  userId: string;
  name: string;
  email: string;
  joinedAt: Date;
  enrollmentCount: number;
  /** Sorted ascending. */
  tags: string[];
  /** Greatest of account creation, enrolment, lesson completion and quiz attempt. */
  lastActivityAt: Date;
}

export interface PersonTag {
  tag: string;
  source: "quiz" | "admin";
  sourceQuizId: string | null;
  createdAt: Date;
}

export interface PersonCourseRow {
  enrollmentId: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  status: "active" | "completed" | "cancelled";
  enrolledAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  completedRequired: number;
  totalRequired: number;
  percent: number;
  lastActivityAt: Date;
}

export interface PersonQuizAttempt {
  id: string;
  scorePercent: number;
  passed: boolean;
  createdAt: Date;
  lessonTitle: string;
  courseTitle: string;
}

export interface PersonCertificate {
  id: string;
  courseId: string;
  courseTitle: string;
  recipientName: string;
  issuedAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface PersonBooking {
  id: string;
  bookingTypeTitle: string;
  status: string;
  startAt: Date | null;
  createdAt: Date;
}

export interface PersonOrder {
  id: string;
  offerTitle: string;
  offerKind: string;
  status: string;
  amountMinor: number | null;
  currency: string | null;
  createdAt: Date;
  paidAt: Date | null;
}

export interface PersonLead {
  id: string;
  kind: string;
  status: string;
  fullName: string;
  companyName: string | null;
  sourceRoute: string;
  createdAt: Date;
}

export interface PersonEmail {
  id: string;
  kind: string;
  subject: string;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
}

export type TimelineKind =
  | "enrolled"
  | "completed"
  | "left"
  | "certificate"
  | "quiz-passed"
  | "quiz-failed"
  | "booking"
  | "order"
  | "lead"
  | "email";

export interface TimelineItem {
  date: Date;
  kind: TimelineKind;
  label: string;
  href?: string;
}

export interface PersonProfile {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    createdAt: Date;
  };
  tags: PersonTag[];
  note: { body: string; updatedAt: Date; updatedBy: string } | null;
  /** Batch J: learner's course-reminder preference (absent row = opted in). */
  courseNudges: boolean;
  courses: PersonCourseRow[];
  quizAttempts: PersonQuizAttempt[];
  certificates: PersonCertificate[];
  bookings: PersonBooking[];
  orders: PersonOrder[];
  leads: PersonLead[];
  emails: PersonEmail[];
  /** Merged, date-sorted (newest first), capped at 50. */
  timeline: TimelineItem[];
}

export const EMAIL_KIND_LABELS: Record<string, string> = {
  password_reset: "Password reset",
  email_verification: "Email verification",
  enrollment_welcome: "Welcome",
  course_completed: "Course completed",
  course_left: "Course left",
  lesson_unlocked: "Lesson unlocked",
  nudge_completed: "Nudge: completed",
  nudge_inactive: "Nudge: inactive",
  nudge_quiz_failed: "Nudge: quiz help",
};

export function emailKindLabel(kind: string): string {
  return EMAIL_KIND_LABELS[kind] ?? kind;
}

// ---------------------------------------------------------------------------
// Row mapping helpers (D1 stores drizzle `timestamp` columns as seconds)
// ---------------------------------------------------------------------------

function toDateSeconds(value: unknown): Date {
  return new Date(Number(value) * 1000);
}

function toDateSecondsOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return new Date(Number(value) * 1000);
}

function mapPersonRow(raw: Record<string, unknown>): PersonRow {
  const joinedAt = toDateSeconds(raw.joinedAt);
  const tags =
    typeof raw.tags === "string" && raw.tags.length > 0
      ? raw.tags.split(",").filter(Boolean).sort()
      : [];
  return {
    userId: String(raw.userId),
    name: String(raw.name),
    email: String(raw.email),
    joinedAt,
    enrollmentCount: Number(raw.enrollmentCount),
    tags,
    lastActivityAt: raw.lastActivityAt === null || raw.lastActivityAt === undefined
      ? joinedAt
      : toDateSeconds(raw.lastActivityAt),
  };
}

/**
 * People list in ONE statement. Last activity follows the Batch H rule
 * (greatest of enrolment, lesson completion and quiz attempt across all of
 * the person's enrollments); the account creation date is folded in as the
 * natural floor, so people without enrollments sort by join date. Tags ride
 * along via group_concat (slugs never contain commas). Substring search uses
 * instr(LOWER(...)) — never LIKE — so `%`/`_` in the input are literal and
 * D1's LIKE-pattern length cap can never 500 the page.
 */
function peopleListSql(opts: { tag: boolean; q: boolean }): string {
  let sql = `
    SELECT u.id AS userId, u.name AS name, u.email AS email,
           u.created_at AS joinedAt,
           (SELECT COUNT(*) FROM enrollments en WHERE en.user_id = u.id) AS enrollmentCount,
           (SELECT group_concat(lt.tag, ',') FROM learner_tags lt WHERE lt.user_id = u.id) AS tags,
           MAX(
             u.created_at,
             COALESCE((SELECT MAX(en.enrolled_at) FROM enrollments en WHERE en.user_id = u.id), 0),
             COALESCE((SELECT MAX(lp.completed_at) FROM lesson_progress lp
                        JOIN enrollments en ON en.id = lp.enrollment_id
                       WHERE en.user_id = u.id), 0),
             COALESCE((SELECT MAX(qa.created_at) FROM quiz_attempts qa WHERE qa.user_id = u.id), 0)
           ) AS lastActivityAt
      FROM "user" u
     WHERE u.role = 'user'
  `;
  if (opts.q) {
    sql += ` AND (instr(LOWER(u.name), LOWER(?)) > 0 OR instr(LOWER(u.email), LOWER(?)) > 0)`;
  }
  if (opts.tag) {
    sql += ` AND EXISTS (SELECT 1 FROM learner_tags lt2 WHERE lt2.user_id = u.id AND lt2.tag = ?)`;
  }
  sql += ` ORDER BY lastActivityAt DESC, u.id ASC`;
  return sql;
}

export async function listPeople(
  opts: { q?: string; tag?: string; page?: number } = {},
): Promise<{ rows: PersonRow[]; hasNextPage: boolean }> {
  await requireAdmin();
  const q = (opts.q ?? "").trim().slice(0, 100);
  const tag = parsePeopleTag(opts.tag ?? "");
  const page = opts.page ?? 1;

  const params: Array<string | number> = [];
  let sql = peopleListSql({ tag: tag !== "", q: q !== "" });
  if (q !== "") params.push(q, q);
  if (tag !== "") params.push(tag);
  sql += ` LIMIT ? OFFSET ?`;
  params.push(PEOPLE_PAGE_SIZE + 1, (page - 1) * PEOPLE_PAGE_SIZE);

  const d1 = await getD1Database();
  const { results } = await d1
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();
  const rows = results.map(mapPersonRow);
  return { rows: rows.slice(0, PEOPLE_PAGE_SIZE), hasNextPage: rows.length > PEOPLE_PAGE_SIZE };
}

/** Full filtered list for the CSV export (one query, capped). */
export async function listAllPeopleForExport(
  opts: { q?: string; tag?: string } = {},
): Promise<PersonRow[]> {
  await requireAdmin();
  const q = (opts.q ?? "").trim().slice(0, 100);
  const tag = parsePeopleTag(opts.tag ?? "");

  const params: Array<string | number> = [];
  let sql = peopleListSql({ tag: tag !== "", q: q !== "" });
  if (q !== "") params.push(q, q);
  if (tag !== "") params.push(tag);
  sql += ` LIMIT ?`;
  params.push(PEOPLE_EXPORT_MAX_ROWS);

  const d1 = await getD1Database();
  const { results } = await d1
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();
  return results.map(mapPersonRow);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function buildTimeline(input: {
  email: string;
  courses: PersonCourseRow[];
  quizAttempts: PersonQuizAttempt[];
  certificates: PersonCertificate[];
  bookings: PersonBooking[];
  orders: PersonOrder[];
  leads: PersonLead[];
  emails: PersonEmail[];
}): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const course of input.courses) {
    const learnersHref = `/admin/courses/${course.courseId}/learners?q=${encodeURIComponent(input.email)}`;
    items.push({ date: course.enrolledAt, kind: "enrolled", label: `Enrolled in ${course.courseTitle}`, href: learnersHref });
    if (course.completedAt) {
      items.push({ date: course.completedAt, kind: "completed", label: `Completed ${course.courseTitle}`, href: learnersHref });
    }
    if (course.cancelledAt) {
      items.push({ date: course.cancelledAt, kind: "left", label: `Left ${course.courseTitle}`, href: learnersHref });
    }
  }
  for (const certificate of input.certificates) {
    items.push({
      date: certificate.issuedAt,
      kind: "certificate",
      label: `Certificate issued for ${certificate.courseTitle}`,
      href: `/certificates/${certificate.id}`,
    });
  }
  for (const attempt of input.quizAttempts) {
    items.push({
      date: attempt.createdAt,
      kind: attempt.passed ? "quiz-passed" : "quiz-failed",
      label: `Quiz ${attempt.passed ? "passed" : "failed"} — ${attempt.lessonTitle} (${attempt.scorePercent}%)`,
    });
  }
  for (const booking of input.bookings) {
    items.push({
      date: booking.createdAt,
      kind: "booking",
      label: `Booking ${booking.status} — ${booking.bookingTypeTitle}`,
    });
  }
  for (const order of input.orders) {
    items.push({
      date: order.createdAt,
      kind: "order",
      label: `Order ${order.status} — ${order.offerTitle}`,
    });
  }
  for (const lead of input.leads) {
    items.push({ date: lead.createdAt, kind: "lead", label: `Lead — ${lead.kind}` });
  }
  for (const email of input.emails) {
    items.push({
      date: email.sentAt ?? email.createdAt,
      kind: "email",
      label: `Email ${emailKindLabel(email.kind)} — ${email.subject}`,
    });
  }
  items.sort((a, b) => b.date.getTime() - a.date.getTime() || (a.label < b.label ? -1 : 1));
  return items.slice(0, 50);
}

/**
 * Full person profile. Unknown ids AND admin ids resolve to null (the page
 * maps that to 404). One user lookup, then the eight section queries run in a
 * single Promise.all — each bounded, each selecting only admin-safe columns
 * (never lesson_notes, never email bodies). The timeline is merged in memory
 * from the already-fetched section rows: zero extra queries.
 */
export async function getPersonProfile(userId: string): Promise<PersonProfile | null> {
  await requireAdmin();
  const d1 = await getD1Database();

  const userRow = await d1
    .prepare(`SELECT id, name, email, email_verified AS emailVerified, created_at AS createdAt, role FROM "user" WHERE id = ?`)
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!userRow || userRow.role !== "user") return null;
  const email = String(userRow.email);

  const [
    tagRows,
    noteRow,
    preferenceRow,
    courseRows,
    attemptRows,
    certificateRows,
    bookingRows,
    orderRows,
    leadRows,
    emailRows,
  ] = await Promise.all([
    d1
      .prepare(`SELECT tag, source, source_quiz_id AS sourceQuizId, created_at AS createdAt FROM learner_tags WHERE user_id = ? ORDER BY tag ASC`)
      .bind(userId)
      .all<Record<string, unknown>>(),
    d1
      .prepare(`SELECT body, updated_at AS updatedAt, updated_by AS updatedBy FROM admin_person_notes WHERE user_id = ?`)
      .bind(userId)
      .first<Record<string, unknown>>(),
    d1
      .prepare(`SELECT course_nudges AS courseNudges FROM email_preferences WHERE user_id = ?`)
      .bind(userId)
      .first<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT en.id AS enrollmentId, en.course_id AS courseId, c.title AS courseTitle, c.slug AS courseSlug,
                en.status AS status, en.enrolled_at AS enrolledAt,
                en.completed_at AS completedAt, en.cancelled_at AS cancelledAt,
                (SELECT COUNT(*) FROM lesson_progress lp
                   JOIN lessons l ON l.id = lp.lesson_id
                  WHERE lp.enrollment_id = en.id AND l.course_id = en.course_id
                    AND l.status = 'published' AND l.required = 1) AS done,
                (SELECT COUNT(*) FROM lessons
                  WHERE course_id = en.course_id AND status = 'published' AND required = 1) AS totalRequired,
                MAX(en.enrolled_at,
                    COALESCE((SELECT MAX(completed_at) FROM lesson_progress WHERE enrollment_id = en.id), en.enrolled_at),
                    COALESCE((SELECT MAX(created_at) FROM quiz_attempts WHERE enrollment_id = en.id), en.enrolled_at)) AS lastActivityAt
           FROM enrollments en JOIN courses c ON c.id = en.course_id
          WHERE en.user_id = ?
          ORDER BY en.enrolled_at DESC, en.id ASC
          LIMIT 100`,
      )
      .bind(userId)
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT qa.id AS id, qa.score_percent AS scorePercent, qa.passed AS passed, qa.created_at AS createdAt,
                COALESCE(l.title, 'Deleted lesson') AS lessonTitle,
                COALESCE(c.title, 'Deleted course') AS courseTitle
           FROM quiz_attempts qa
           LEFT JOIN lessons l ON l.id = qa.lesson_id
           LEFT JOIN courses c ON c.id = l.course_id
          WHERE qa.user_id = ?
          ORDER BY qa.created_at DESC, qa.id ASC
          LIMIT ${PROFILE_ATTEMPT_LIMIT}`,
      )
      .bind(userId)
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT id, course_id AS courseId, course_title AS courseTitle, recipient_name AS recipientName,
                issued_at AS issuedAt, revoked_at AS revokedAt, revoked_reason AS revokedReason
           FROM certificates WHERE user_id = ? ORDER BY issued_at DESC, id ASC LIMIT ${PROFILE_LIST_LIMIT}`,
      )
      .bind(userId)
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT b.id AS id, COALESCE(bt.title, 'Deleted booking type') AS bookingTypeTitle,
                b.status AS status, b.start_at AS startAt, b.created_at AS createdAt
           FROM bookings b LEFT JOIN booking_types bt ON bt.id = b.booking_type_id
          WHERE lower(b.requester_email) = lower(?)
          ORDER BY b.created_at DESC, b.id ASC LIMIT ${PROFILE_LIST_LIMIT}`,
      )
      .bind(email)
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT o.id AS id, COALESCE(off.title, o.offer_kind) AS offerTitle, o.offer_kind AS offerKind,
                o.status AS status, o.amount_minor AS amountMinor, o.currency AS currency,
                o.created_at AS createdAt, o.paid_at AS paidAt
           FROM orders o LEFT JOIN offers off ON off.id = o.offer_id
          WHERE o.user_id = ? OR lower(o.customer_email) = lower(?)
          ORDER BY o.created_at DESC, o.id ASC LIMIT ${PROFILE_LIST_LIMIT}`,
      )
      .bind(userId, email)
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT id, kind, status, full_name AS fullName, company_name AS companyName,
                source_route AS sourceRoute, created_at AS createdAt
           FROM lead_submissions WHERE lower(email) = lower(?)
           ORDER BY created_at DESC, id ASC LIMIT ${PROFILE_LIST_LIMIT}`,
      )
      .bind(email)
      .all<Record<string, unknown>>(),
    // Never select text_body/html_body: subject lines only.
    d1
      .prepare(
        `SELECT id, kind, subject, status, created_at AS createdAt, sent_at AS sentAt
           FROM email_outbox WHERE lower(to_address) = lower(?)
           ORDER BY created_at DESC, id ASC LIMIT ${PROFILE_EMAIL_LIMIT}`,
      )
      .bind(email)
      .all<Record<string, unknown>>(),
  ]);

  const courses: PersonCourseRow[] = courseRows.results.map((raw) => {
    const totalRequired = Number(raw.totalRequired);
    const completedRequired = Number(raw.done);
    return {
      enrollmentId: String(raw.enrollmentId),
      courseId: String(raw.courseId),
      courseTitle: String(raw.courseTitle),
      courseSlug: String(raw.courseSlug),
      status: raw.status as PersonCourseRow["status"],
      enrolledAt: toDateSeconds(raw.enrolledAt),
      completedAt: toDateSecondsOrNull(raw.completedAt),
      cancelledAt: toDateSecondsOrNull(raw.cancelledAt),
      completedRequired,
      totalRequired,
      percent: totalRequired === 0 ? 0 : Math.round((completedRequired / totalRequired) * 100),
      lastActivityAt: toDateSeconds(raw.lastActivityAt),
    };
  });

  const quizAttempts: PersonQuizAttempt[] = attemptRows.results.map((raw) => ({
    id: String(raw.id),
    scorePercent: Number(raw.scorePercent),
    passed: Number(raw.passed) === 1,
    createdAt: toDateSeconds(raw.createdAt),
    lessonTitle: String(raw.lessonTitle),
    courseTitle: String(raw.courseTitle),
  }));

  const certificates: PersonCertificate[] = certificateRows.results.map((raw) => ({
    id: String(raw.id),
    courseId: String(raw.courseId),
    courseTitle: String(raw.courseTitle),
    recipientName: String(raw.recipientName),
    issuedAt: toDateSeconds(raw.issuedAt),
    revokedAt: toDateSecondsOrNull(raw.revokedAt),
    revokedReason: raw.revokedReason === null ? null : String(raw.revokedReason),
  }));

  const bookings: PersonBooking[] = bookingRows.results.map((raw) => ({
    id: String(raw.id),
    bookingTypeTitle: String(raw.bookingTypeTitle),
    status: String(raw.status),
    startAt: toDateSecondsOrNull(raw.startAt),
    createdAt: toDateSeconds(raw.createdAt),
  }));

  const orders: PersonOrder[] = orderRows.results.map((raw) => ({
    id: String(raw.id),
    offerTitle: String(raw.offerTitle),
    offerKind: String(raw.offerKind),
    status: String(raw.status),
    amountMinor: raw.amountMinor === null ? null : Number(raw.amountMinor),
    currency: raw.currency === null ? null : String(raw.currency),
    createdAt: toDateSeconds(raw.createdAt),
    paidAt: toDateSecondsOrNull(raw.paidAt),
  }));

  const leads: PersonLead[] = leadRows.results.map((raw) => ({
    id: String(raw.id),
    kind: String(raw.kind),
    status: String(raw.status),
    fullName: String(raw.fullName),
    companyName: raw.companyName === null ? null : String(raw.companyName),
    sourceRoute: String(raw.sourceRoute),
    createdAt: toDateSeconds(raw.createdAt),
  }));

  const emails: PersonEmail[] = emailRows.results.map((raw) => ({
    id: String(raw.id),
    kind: String(raw.kind),
    subject: String(raw.subject),
    status: String(raw.status),
    createdAt: toDateSeconds(raw.createdAt),
    sentAt: toDateSecondsOrNull(raw.sentAt),
  }));

  const tags: PersonTag[] = tagRows.results.map((raw) => ({
    tag: String(raw.tag),
    source: raw.source as PersonTag["source"],
    sourceQuizId: raw.sourceQuizId === null ? null : String(raw.sourceQuizId),
    createdAt: toDateSeconds(raw.createdAt),
  }));

  return {
    user: {
      id: String(userRow.id),
      name: String(userRow.name),
      email,
      emailVerified: Number(userRow.emailVerified) === 1,
      createdAt: toDateSeconds(userRow.createdAt),
    },
    tags,
    note: noteRow
      ? {
          body: String(noteRow.body),
          updatedAt: toDateSeconds(noteRow.updatedAt),
          updatedBy: String(noteRow.updatedBy),
        }
      : null,
    courses,
    quizAttempts,
    certificates,
    bookings,
    orders,
    leads,
    emails,
    // Absent row = default opted in; stored 0 = opted out.
    courseNudges: preferenceRow ? Number(preferenceRow.courseNudges) === 1 : true,
    timeline: buildTimeline({ email, courses, quizAttempts, certificates, bookings, orders, leads, emails }),
  };
}

// ---------------------------------------------------------------------------
// Mutations (audited by the caller — see src/features/audit/service.ts)
// ---------------------------------------------------------------------------

function normalizeTag(input: unknown): string {
  return typeof input === "string" ? input.trim().toLowerCase() : "";
}

async function requirePersonUserId(userId: string): Promise<void> {
  const db = await getDb();
  const row = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row || row.role !== "user") {
    throw new AppError("not_found", "Person not found.");
  }
}

/** Admin-set tag. Idempotent: re-adding keeps the first writer (incl. quiz source). */
export async function addPersonTag(userId: string, tagInput: unknown): Promise<{ tag: string }> {
  await requireAdmin();
  const tag = normalizeTag(tagInput);
  if (!LEARNER_TAG_PATTERN.test(tag)) {
    throw new AppError(
      "invalid",
      "Tag must be a lowercase slug: letters, numbers and dashes, up to 40 characters.",
    );
  }
  await requirePersonUserId(userId);
  const db = await getDb();
  await db
    .insert(learnerTags)
    .values({
      id: `ltag_${crypto.randomUUID().slice(0, 12)}`,
      userId,
      tag,
      source: "admin",
      sourceQuizId: null,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: [learnerTags.userId, learnerTags.tag] });
  return { tag };
}

export async function removePersonTag(userId: string, tagInput: unknown): Promise<{ tag: string }> {
  await requireAdmin();
  const tag = normalizeTag(tagInput);
  if (!LEARNER_TAG_PATTERN.test(tag)) {
    throw new AppError(
      "invalid",
      "Tag must be a lowercase slug: letters, numbers and dashes, up to 40 characters.",
    );
  }
  await requirePersonUserId(userId);
  const db = await getDb();
  await db
    .delete(learnerTags)
    .where(and(eq(learnerTags.userId, userId), eq(learnerTags.tag, tag)));
  return { tag };
}

/**
 * Upsert the private admin note. An empty body clears the note (row deleted).
 * The body is never copied into audit details — the caller audits bare facts.
 */
export async function savePersonNote(
  userId: string,
  bodyInput: unknown,
  adminId: string,
): Promise<{ cleared: boolean }> {
  await requireAdmin();
  const body = typeof bodyInput === "string" ? bodyInput.trim() : "";
  if (body.length > PERSON_NOTE_MAX_LENGTH) {
    throw new AppError("invalid", `Note must be at most ${PERSON_NOTE_MAX_LENGTH} characters.`);
  }
  await requirePersonUserId(userId);
  const db = await getDb();
  if (body === "") {
    await db.delete(adminPersonNotes).where(eq(adminPersonNotes.userId, userId));
    return { cleared: true };
  }
  await db
    .insert(adminPersonNotes)
    .values({ userId, body, updatedAt: new Date(), updatedBy: adminId })
    .onConflictDoUpdate({
      target: adminPersonNotes.userId,
      set: { body, updatedAt: new Date(), updatedBy: adminId },
    });
  return { cleared: false };
}
