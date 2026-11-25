// ============================================================================
// LEARNERS SERVICE (Batch H — "Know your learners")
// ----------------------------------------------------------------------------
// Admin-only read projections over enrollments. Every function calls
// requireAdmin(). Query budget is deliberately tiny (Workers Free):
//   - listCourseLearners:    ONE SQL statement (+ no curriculum query; the
//     required-published total is a correlated subquery in the same statement)
//   - getCourseLearnerSummary: ONE grouped SQL statement
//   - getStuckCountsForCourses: ONE grouped SQL statement (chunked IN)
//   - getStudioLearnerAttention: exactly 3 SQL statements
// No per-learner query loops. lesson_notes is never read (owner-only).
// ============================================================================

import { requireAdmin } from "@/lib/auth";
import { getD1Database } from "@/lib/cloudflare/bindings";

export const STUCK_AFTER_DAYS = 14;
export const LEARNERS_PAGE_SIZE = 25;
export const LEARNERS_EXPORT_MAX_ROWS = 5000;

const DAY_SECONDS = 86400;

export type LearnerFilter =
  | "all"
  | "not-started"
  | "in-progress"
  | "stuck"
  | "completed"
  | "left";

export const LEARNER_FILTERS: readonly LearnerFilter[] = [
  "all",
  "not-started",
  "in-progress",
  "stuck",
  "completed",
  "left",
];

export function parseLearnerFilter(value: unknown): LearnerFilter {
  return typeof value === "string" &&
    (LEARNER_FILTERS as readonly string[]).includes(value)
    ? (value as LearnerFilter)
    : "all";
}

/** Trimmed search text, max 100 chars; empty string means "no search". */
export function parseLearnerQuery(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

export function parseLearnerPage(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) return 1;
  return Math.max(1, Math.min(10000, n));
}

export type LearnerEnrollmentStatus = "active" | "completed" | "cancelled";

export interface CourseLearnerRow {
  enrollmentId: string;
  userId: string;
  name: string;
  email: string;
  status: LearnerEnrollmentStatus;
  enrolledAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  lastActivityAt: Date;
  completedRequired: number;
  totalRequired: number;
  percent: number;
  hasCertificate: boolean;
  /** Active, not complete, and last activity older than STUCK_AFTER_DAYS. */
  isStuck: boolean;
}

export interface CourseLearnerSummary {
  all: number;
  notStarted: number;
  inProgress: number;
  stuck: number;
  completed: number;
  left: number;
}

export interface StudioLearnerAttention {
  stuck: number;
  completedThisWeek: number;
  quizFailuresThisWeek: number;
  /** Course with the most stuck learners (ties: lexicographically first id). */
  topStuckCourseId: string | null;
}

// ---------------------------------------------------------------------------
// SQL fragments (raw D1: one statement per read, all values bound)
// ---------------------------------------------------------------------------

/**
 * Per-enrollment aggregates as correlated, INDEXED lookups (lesson_progress
 * unique (enrollment_id, lesson_id), lessons_course_idx, quiz_attempts
 * (enrollment_id, created_at), certificates unique (user_id, course_id)), so
 * cost scales with the enrollments in scope, never with whole-table scans.
 * `done` counts REQUIRED PUBLISHED lessons of this course only — the same
 * set computeCourseProgress uses. Activity counts every lesson completion
 * and quiz attempt. MATERIALIZED stops SQLite from flattening the CTE and
 * re-running the subqueries in WHERE / ORDER BY.
 */
function learnerCte(scopeSql: string): string {
  return `
  WITH e AS MATERIALIZED (
    SELECT en.id, en.user_id, en.course_id, en.status, en.enrolled_at,
           en.completed_at, en.cancelled_at,
           (SELECT COUNT(*) FROM lesson_progress lp
              JOIN lessons l ON l.id = lp.lesson_id
             WHERE lp.enrollment_id = en.id AND l.course_id = en.course_id
               AND l.status = 'published' AND l.required = 1) AS done,
           (SELECT COUNT(*) FROM lessons
             WHERE course_id = en.course_id AND status = 'published' AND required = 1) AS total_required,
           MAX(en.enrolled_at,
               COALESCE((SELECT MAX(completed_at) FROM lesson_progress WHERE enrollment_id = en.id), en.enrolled_at),
               COALESCE((SELECT MAX(created_at) FROM quiz_attempts WHERE enrollment_id = en.id), en.enrolled_at)) AS last_activity,
           EXISTS (SELECT 1 FROM certificates c
                    WHERE c.user_id = en.user_id AND c.course_id = en.course_id
                      AND c.revoked_at IS NULL) AS has_cert
      FROM enrollments en
     WHERE ${scopeSql}
  )`;
}

const LEARNER_SELECT_SQL = `
  SELECT e.id AS enrollmentId, e.user_id AS userId,
         u.name AS name, u.email AS email, e.status AS status,
         e.enrolled_at AS enrolledAt, e.completed_at AS completedAt,
         e.cancelled_at AS cancelledAt,
         e.last_activity AS lastActivityAt,
         e.done AS completedRequired,
         e.total_required AS totalRequired,
         e.has_cert AS hasCertificate
    FROM e JOIN "user" u ON u.id = e.user_id
`;

const STUCK_SQL = `e.status = 'active' AND e.done < e.total_required AND e.last_activity < ?`;

/**
 * Substring search without LIKE: D1 rejects LIKE patterns of ~50+ characters
 * ("LIKE or GLOB pattern too complex"), which would 500 the page on ordinary
 * long names or emails. `instr(LOWER(col), LOWER(?))` is a literal,
 * case-insensitive substring match with identical semantics — wildcards in
 * the input (`%`, `_`, `\`) can never act as pattern syntax, so no escaping
 * layer is needed and every bound value is safe at any length.
 */

function toDateSeconds(value: unknown): Date {
  return new Date(Number(value) * 1000);
}

function toDateSecondsOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return new Date(Number(value) * 1000);
}

function mapLearnerRow(raw: Record<string, unknown>, stuckCutoffSec: number): CourseLearnerRow {
  const totalRequired = Number(raw.totalRequired);
  const completedRequired = Number(raw.completedRequired);
  const percent =
    totalRequired === 0 ? 0 : Math.round((completedRequired / totalRequired) * 100);
  const status = raw.status as LearnerEnrollmentStatus;
  const lastActivityAt = toDateSeconds(raw.lastActivityAt);
  return {
    enrollmentId: String(raw.enrollmentId),
    userId: String(raw.userId),
    name: String(raw.name),
    email: String(raw.email),
    status,
    enrolledAt: toDateSeconds(raw.enrolledAt),
    completedAt: toDateSecondsOrNull(raw.completedAt),
    cancelledAt: toDateSecondsOrNull(raw.cancelledAt),
    lastActivityAt,
    completedRequired,
    totalRequired,
    percent,
    hasCertificate: Number(raw.hasCertificate) === 1,
    isStuck:
      status === "active" &&
      completedRequired < totalRequired &&
      Math.floor(lastActivityAt.getTime() / 1000) < stuckCutoffSec,
  };
}

function filterCondition(
  filter: LearnerFilter,
  stuckCutoffSec: number,
): { sql: string; params: number[] } {
  switch (filter) {
    case "not-started":
      return { sql: `AND e.status = 'active' AND e.done = 0`, params: [] };
    case "in-progress":
      return {
        sql: `AND e.status = 'active' AND e.done > 0 AND e.done < e.total_required`,
        params: [],
      };
    case "stuck":
      return {
        sql: `AND ${STUCK_SQL}`,
        params: [stuckCutoffSec],
      };
    case "completed":
      return { sql: `AND e.status = 'completed'`, params: [] };
    case "left":
      return { sql: `AND e.status = 'cancelled'`, params: [] };
    case "all":
    default:
      return { sql: ``, params: [] };
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCourseLearners(
  courseId: string,
  opts: { filter?: LearnerFilter; page?: number; q?: string; tag?: string; now?: Date | number } = {},
): Promise<{ rows: CourseLearnerRow[]; hasNextPage: boolean }> {
  await requireAdmin();
  const filter = opts.filter ?? "all";
  const page = opts.page ?? 1;
  const q = (opts.q ?? "").trim().slice(0, 100);
  // Batch I: extra EXISTS filter over learner_tags (one bound param, no join).
  const tag = (opts.tag ?? "").trim().toLowerCase().slice(0, 100);
  const nowSec = Math.floor(
    (opts.now instanceof Date ? opts.now.getTime() : (opts.now ?? Date.now())) / 1000,
  );
  const stuckCutoffSec = nowSec - STUCK_AFTER_DAYS * DAY_SECONDS;

  const cond = filterCondition(filter, stuckCutoffSec);
  const params: Array<string | number> = [courseId, ...cond.params];
  let sql = `${learnerCte("en.course_id = ?")} ${LEARNER_SELECT_SQL} WHERE 1 = 1 ${cond.sql}`;
  if (q) {
    sql += ` AND (instr(LOWER(u.name), LOWER(?)) > 0 OR instr(LOWER(u.email), LOWER(?)) > 0)`;
    params.push(q, q);
  }
  if (tag) {
    sql += ` AND EXISTS (SELECT 1 FROM learner_tags lt WHERE lt.user_id = e.user_id AND lt.tag = ?)`;
    params.push(tag);
  }
  sql += ` ORDER BY e.last_activity DESC, e.id ASC LIMIT ? OFFSET ?`;
  params.push(LEARNERS_PAGE_SIZE + 1, (page - 1) * LEARNERS_PAGE_SIZE);

  const d1 = await getD1Database();
  const { results } = await d1
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();
  const rows = results.map((r) => mapLearnerRow(r, stuckCutoffSec));
  return {
    rows: rows.slice(0, LEARNERS_PAGE_SIZE),
    hasNextPage: rows.length > LEARNERS_PAGE_SIZE,
  };
}

/** Fetch up to LEARNERS_EXPORT_MAX_ROWS rows for the CSV export (one query). */
export async function listAllCourseLearnersForExport(
  courseId: string,
  opts: { filter?: LearnerFilter; q?: string; tag?: string; now?: Date | number } = {},
): Promise<CourseLearnerRow[]> {
  await requireAdmin();
  const filter = opts.filter ?? "all";
  const q = (opts.q ?? "").trim().slice(0, 100);
  const tag = (opts.tag ?? "").trim().toLowerCase().slice(0, 100);
  const nowSec = Math.floor(
    (opts.now instanceof Date ? opts.now.getTime() : (opts.now ?? Date.now())) / 1000,
  );
  const stuckCutoffSec = nowSec - STUCK_AFTER_DAYS * DAY_SECONDS;

  const cond = filterCondition(filter, stuckCutoffSec);
  const params: Array<string | number> = [courseId, ...cond.params];
  let sql = `${learnerCte("en.course_id = ?")} ${LEARNER_SELECT_SQL} WHERE 1 = 1 ${cond.sql}`;
  if (q) {
    sql += ` AND (instr(LOWER(u.name), LOWER(?)) > 0 OR instr(LOWER(u.email), LOWER(?)) > 0)`;
    params.push(q, q);
  }
  if (tag) {
    sql += ` AND EXISTS (SELECT 1 FROM learner_tags lt WHERE lt.user_id = e.user_id AND lt.tag = ?)`;
    params.push(tag);
  }
  sql += ` ORDER BY e.last_activity DESC, e.id ASC LIMIT ?`;
  params.push(LEARNERS_EXPORT_MAX_ROWS);

  const d1 = await getD1Database();
  const { results } = await d1
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();
  return results.map((r) => mapLearnerRow(r, stuckCutoffSec));
}

/** Counts per filter chip in ONE grouped query. */
export async function getCourseLearnerSummary(courseId: string): Promise<CourseLearnerSummary> {
  await requireAdmin();
  const nowSec = Math.floor(Date.now() / 1000);
  const stuckCutoffSec = nowSec - STUCK_AFTER_DAYS * DAY_SECONDS;
  const d1 = await getD1Database();
  const sql = `
    ${learnerCte("en.course_id = ?")}
    SELECT COUNT(*) AS allCount,
           SUM(CASE WHEN e.status = 'active' AND e.done = 0 THEN 1 ELSE 0 END) AS notStarted,
           SUM(CASE WHEN e.status = 'active' AND e.done > 0 AND e.done < e.total_required THEN 1 ELSE 0 END) AS inProgress,
           SUM(CASE WHEN ${STUCK_SQL} THEN 1 ELSE 0 END) AS stuck,
           SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN e.status = 'cancelled' THEN 1 ELSE 0 END) AS leftCount
      FROM e
  `;
  const row = await d1
    .prepare(sql)
    .bind(courseId, stuckCutoffSec)
    .first<Record<string, unknown>>();
  return {
    all: Number(row?.allCount ?? 0),
    notStarted: Number(row?.notStarted ?? 0),
    inProgress: Number(row?.inProgress ?? 0),
    stuck: Number(row?.stuck ?? 0),
    completed: Number(row?.completed ?? 0),
    left: Number(row?.leftCount ?? 0),
  };
}

/** Stuck-learner counts for many courses in ONE grouped query. Missing ids map to 0. */
export async function getStuckCountsForCourses(courseIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const id of courseIds) out[id] = 0;
  if (courseIds.length === 0) return out;
  await requireAdmin();
  const nowSec = Math.floor(Date.now() / 1000);
  const stuckCutoffSec = nowSec - STUCK_AFTER_DAYS * DAY_SECONDS;
  const d1 = await getD1Database();
  // D1 caps bound parameters per statement (100); chunk large lists.
  for (let i = 0; i < courseIds.length; i += 90) {
    const chunk = courseIds.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(", ");
    const sql = `
      ${learnerCte(`en.course_id IN (${placeholders}) AND en.status = 'active'`)}
      SELECT e.course_id AS courseId, COUNT(*) AS stuck
        FROM e
       WHERE ${STUCK_SQL}
       GROUP BY e.course_id
    `;
    const { results } = await d1
      .prepare(sql)
      .bind(...chunk, stuckCutoffSec)
      .all<{ courseId: string; stuck: number }>();
    for (const row of results) out[row.courseId] = Number(row.stuck);
  }
  return out;
}

/** Dashboard attention metrics in exactly 3 queries. */
export async function getStudioLearnerAttention(
  now: Date | number = Date.now(),
): Promise<StudioLearnerAttention> {
  await requireAdmin();
  const nowSec = Math.floor((now instanceof Date ? now.getTime() : now) / 1000);
  const stuckCutoffSec = nowSec - STUCK_AFTER_DAYS * DAY_SECONDS;
  const weekAgoSec = nowSec - 7 * DAY_SECONDS;
  const d1 = await getD1Database();

  const [stuckRows, completedRow, quizRow] = await Promise.all([
    d1
      .prepare(
        `
        ${learnerCte("en.status = 'active'")}
        SELECT e.course_id AS courseId, COUNT(*) AS stuck
          FROM e
         WHERE ${STUCK_SQL}
         GROUP BY e.course_id
        `,
      )
      .bind(stuckCutoffSec)
      .all<{ courseId: string; stuck: number }>(),
    d1
      .prepare(`SELECT COUNT(*) AS n FROM enrollments WHERE completed_at IS NOT NULL AND completed_at >= ?`)
      .bind(weekAgoSec)
      .first<{ n: number }>(),
    d1
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT DISTINCT user_id, quiz_id FROM quiz_attempts WHERE passed = 0 AND created_at >= ?)`,
      )
      .bind(weekAgoSec)
      .first<{ n: number }>(),
  ]);

  let stuck = 0;
  let topStuckCourseId: string | null = null;
  let topStuck = 0;
  for (const row of stuckRows.results) {
    const n = Number(row.stuck);
    stuck += n;
    if (n > topStuck || (n === topStuck && (topStuckCourseId === null || row.courseId < topStuckCourseId))) {
      topStuck = n;
      topStuckCourseId = row.courseId;
    }
  }
  return {
    stuck,
    completedThisWeek: Number(completedRow?.n ?? 0),
    quizFailuresThisWeek: Number(quizRow?.n ?? 0),
    topStuckCourseId,
  };
}
