/**
 * LEARNERS (Batch H — "Know your learners")
 * ---------------------------------------------------------------------------
 * - Admin-only service reads + CSV export route.
 * - percent matches computeCourseProgress on the same fixture; unpublished and
 *   optional lessons never affect the denominator.
 * - Every filter (incl. stuck via backdated rows, left via cancelled
 *   enrollment), literal-% search, page-size+1 pagination, lastActivityAt as
 *   the greatest of enrolment/progress/quiz, revoked certificates, dashboard
 *   attention counts, CSV escaping + formula-injection guard, audit row and
 *   private no-store + attachment headers on export.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import "./helpers/env";
import { markEmailVerified } from "./helpers/verified";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import {
  adminAuditLog,
  certificates,
  enrollments,
  getDb,
  lessonProgress,
  quizAttempts,
  users,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  clearD1DatabaseForTest,
  disposeCloudflareBindings,
  getD1Database,
  setD1DatabaseForTest,
} from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import {
  createCourse,
  createLesson,
  createSection,
  publishCourse,
  publishLesson,
} from "../src/features/courses/service";
import { getPublishedCourseLessons } from "../src/features/courses/service";
import { computeCourseProgress } from "../src/features/progress/service";
import {
  LEARNERS_PAGE_SIZE,
  getCourseLearnerSummary,
  getStuckCountsForCourses,
  getStudioLearnerAttention,
  listAllCourseLearnersForExport,
  listCourseLearners,
  type LearnerFilter,
} from "../src/features/learners/service";
import { buildCsv, toCsvCell, toCsvRow } from "../src/lib/csv";
import { generateCertificateId } from "../src/features/certificates/types";

process.env.ADMIN_REQUIRE_2FA = "false";
const nodeRequire = createRequire(__filename);
let cookieHeader = "";
let learnerCookie = "";
let adminCookie = "";
let adminId = "";
let exportRoute: typeof import("../src/app/admin/courses/[courseId]/learners/export/route");

const uid = () => crypto.randomUUID().slice(0, 8);
const DAY_MS = 86400000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
const secs = (d: Date) => Math.floor(d.getTime() / 1000) * 1000;

function stubModule(id: string, exports: Record<string, unknown>) {
  const resolved = nodeRequire.resolve(id);
  nodeRequire.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

async function account(admin: boolean) {
  const auth = await getAuth();
  const email = `learner-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({
    body: { email, password, name: "Learner Fixture" },
  });
  if (admin) await (await getDb()).update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));
  await markEmailVerified(created.user.id);
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return {
    id: created.user.id,
    cookie: signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
  };
}

async function makeUser(name: string, email: string) {
  const db = await getDb();
  const id = `user_${uid()}`;
  await db.insert(users).values({
    id, name, email, role: "user",
    createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

async function makeCourse(slug: string, specs: Array<{ required: boolean; published: boolean }>) {
  cookieHeader = adminCookie;
  const course = await createCourse({ title: `Course ${slug}`, slug: `learners-${slug}-${uid()}` });
  const section = await createSection({ courseId: course.id, title: "Section" });
  const lessonIds: string[] = [];
  for (const [i, spec] of specs.entries()) {
    const lesson = await createLesson({
      courseId: course.id, sectionId: section.id,
      title: `Lesson ${i}`, slug: `lesson-${i}-${uid()}`, required: spec.required,
    });
    if (spec.published) await publishLesson(lesson.id);
    lessonIds.push(lesson.id);
  }
  await publishCourse(course.id);
  return { course, lessonIds };
}

async function enroll(userId: string, courseId: string, patch: Partial<{
  status: "active" | "completed" | "cancelled"; enrolledAt: Date; completedAt: Date | null; cancelledAt: Date | null;
}> = {}) {
  const db = await getDb();
  const id = `enroll_${uid()}`;
  await db.insert(enrollments).values({
    id, userId, courseId,
    status: patch.status ?? "active",
    accessSource: "free",
    enrolledAt: patch.enrolledAt ?? new Date(),
    completedAt: patch.completedAt ?? null,
    cancelledAt: patch.cancelledAt ?? null,
  });
  return id;
}

async function complete(userId: string, enrollmentId: string, lessonId: string, at: Date) {
  const db = await getDb();
  await db.insert(lessonProgress).values({
    id: `prog_${uid()}`, enrollmentId, lessonId, completedAt: at,
  });
}

async function attempt(userId: string, enrollmentId: string, quizId: string, lessonId: string, passed: boolean, at: Date) {
  const db = await getDb();
  await db.insert(quizAttempts).values({
    id: `att_${uid()}`, quizId, userId, enrollmentId, lessonId,
    answers: "{}", scorePercent: passed ? 100 : 0,
    correctCount: passed ? 1 : 0, totalCount: 1, passed, createdAt: at,
  });
}

async function certify(userId: string, courseId: string, enrollmentId: string, revoked: boolean) {
  const db = await getDb();
  await db.insert(certificates).values({
    id: generateCertificateId(), userId, courseId, enrollmentId,
    recipientName: "Fixture Learner", courseTitle: "Fixture Course",
    issuedAt: new Date(), revokedAt: revoked ? new Date() : null,
    revokedReason: revoked ? "review" : null,
  });
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn });
  const learner = await account(false);
  learnerCookie = learner.cookie;
  const admin = await account(true);
  adminId = admin.id; adminCookie = admin.cookie;
  exportRoute = await import("../src/app/admin/courses/[courseId]/learners/export/route");
});
test.after(async () => { await disposeCloudflareBindings(); });

test("non-admin callers are refused for every learners service function", async () => {
  cookieHeader = adminCookie;
  const { course } = await makeCourse("gate", [{ required: true, published: true }]);
  for (const cookie of ["", learnerCookie]) {
    cookieHeader = cookie;
    await assert.rejects(() => listCourseLearners(course.id, {}), /Unauthorized|Forbidden/);
    await assert.rejects(() => listAllCourseLearnersForExport(course.id, {}), /Unauthorized|Forbidden/);
    await assert.rejects(() => getCourseLearnerSummary(course.id), /Unauthorized|Forbidden/);
    await assert.rejects(() => getStuckCountsForCourses([course.id]), /Unauthorized|Forbidden/);
    await assert.rejects(() => getStudioLearnerAttention(), /Unauthorized|Forbidden/);
  }
  cookieHeader = adminCookie;
});

test("export route refuses anonymous (401) and non-admin (403) without audit rows", async () => {
  cookieHeader = adminCookie;
  const { course } = await makeCourse("gate-export", [{ required: true, published: true }]);
  const db = await getDb();
  const before = await db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, course.id));
  for (const [cookie, status] of [["", 401], [learnerCookie, 403]] as const) {
    cookieHeader = cookie;
    const res = await exportRoute.GET(
      new Request(`https://studio.test/admin/courses/${course.id}/learners/export`),
      { params: Promise.resolve({ courseId: course.id }) },
    );
    assert.equal(res.status, status);
  }
  cookieHeader = adminCookie;
  const after = await db.select().from(adminAuditLog).where(eq(adminAuditLog.entityId, course.id));
  assert.equal(after.length, before.length);
});

test("percent matches computeCourseProgress; unpublished and optional lessons ignored", async () => {
  cookieHeader = adminCookie;
  // 2 required published + 1 optional published + 1 required draft.
  const { course, lessonIds } = await makeCourse("maths", [
    { required: true, published: true },
    { required: true, published: true },
    { required: false, published: true },
    { required: true, published: false },
  ]);
  const userId = await makeUser("Maths Learner", `maths-${uid()}@example.test`);
  const enrollmentId = await enroll(userId, course.id);
  // Complete one required, the optional, AND the draft (stray row).
  await complete(userId, enrollmentId, lessonIds[0], new Date());
  await complete(userId, enrollmentId, lessonIds[2], new Date());
  await complete(userId, enrollmentId, lessonIds[3], new Date());

  cookieHeader = adminCookie;
  const { rows } = await listCourseLearners(course.id, {});
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.totalRequired, 2);
  assert.equal(row.completedRequired, 1);
  assert.equal(row.percent, 50);

  const published = await getPublishedCourseLessons(course.id);
  const db = await getDb();
  const done = await db.select().from(lessonProgress).where(eq(lessonProgress.enrollmentId, enrollmentId));
  const expected = computeCourseProgress(published, done.map((r) => r.lessonId));
  assert.equal(row.percent, expected.percent);
  assert.equal(row.completedRequired, expected.completedRequired);
  assert.equal(row.totalRequired, expected.totalRequired);

  // Optional-only completion on a fresh enrollment leaves percent at 0.
  const userId2 = await makeUser("Optional Only", `optional-${uid()}@example.test`);
  const enrollmentId2 = await enroll(userId2, course.id);
  await complete(userId2, enrollmentId2, lessonIds[2], new Date());
  const second = (await listCourseLearners(course.id, {})).rows.find((r) => r.enrollmentId === enrollmentId2)!;
  assert.equal(second.percent, 0);
  assert.equal(second.totalRequired, 2);
});

test("each filter selects the right learners and the summary agrees", async () => {
  cookieHeader = adminCookie;
  const { course, lessonIds } = await makeCourse("filters", [
    { required: true, published: true },
    { required: true, published: true },
  ]);
  const mk = async (name: string) => makeUser(name, `${name.toLowerCase().replaceAll(" ", "-")}-${uid()}@example.test`);

  // not-started: active, 0 done, recent.
  const freshId = await mk("Fresh Start");
  const freshEnroll = await enroll(freshId, course.id);
  // in-progress: active, 1 of 2 done, recent.
  const progId = await mk("Partial Progress");
  const progEnroll = await enroll(progId, course.id);
  await complete(progId, progEnroll, lessonIds[0], new Date());
  // stuck: active, 0 done, enrolled 20 days ago (older than STUCK_AFTER_DAYS=14).
  const stuckId = await mk("Stuck Learner");
  const stuckEnroll = await enroll(stuckId, course.id, { enrolledAt: ago(20) });
  // stuck via backdated progress: enrolled AND active 20 days ago (last
  // activity is the GREATEST of enrolment/progress/quiz, so the enrolment
  // must also be old — a recent enrolment is never stuck).
  const staleId = await mk("Stale Learner");
  const staleEnroll = await enroll(staleId, course.id, { enrolledAt: ago(20) });
  await complete(staleId, staleEnroll, lessonIds[0], ago(20));
  // completed: stored status completed.
  const doneId = await mk("Done Learner");
  const doneEnroll = await enroll(doneId, course.id, { status: "completed", completedAt: ago(2) });
  // left: cancelled.
  const leftId = await mk("Left Learner");
  const leftEnroll = await enroll(leftId, course.id, { status: "cancelled", cancelledAt: ago(3) });

  cookieHeader = adminCookie;
  const ids = async (filter: LearnerFilter) =>
    (await listCourseLearners(course.id, { filter })).rows.map((r) => r.enrollmentId).sort();
  assert.deepEqual(await ids("all"), [doneEnroll, freshEnroll, leftEnroll, progEnroll, staleEnroll, stuckEnroll].sort());
  assert.deepEqual(await ids("not-started"), [freshEnroll, stuckEnroll].sort());
  assert.deepEqual(await ids("in-progress"), [progEnroll, staleEnroll].sort());
  assert.deepEqual(await ids("stuck"), [staleEnroll, stuckEnroll].sort());
  assert.deepEqual(await ids("completed"), [doneEnroll]);
  assert.deepEqual(await ids("left"), [leftEnroll]);

  const summary = await getCourseLearnerSummary(course.id);
  assert.deepEqual(summary, {
    all: 6, notStarted: 2, inProgress: 2, stuck: 2, completed: 1, left: 1,
  });

  // Badge rollup for the courses list: one grouped query for many courses.
  const { course: other } = await makeCourse("filters-other", [{ required: true, published: true }]);
  const grouped = await getStuckCountsForCourses([course.id, other.id, "missing-id"]);
  assert.deepEqual(grouped, { [course.id]: 2, [other.id]: 0, "missing-id": 0 });
  assert.deepEqual(await getStuckCountsForCourses([]), {});
});

test("search matches name or email case-insensitively and treats % and _ literally", async () => {
  cookieHeader = adminCookie;
  const { course } = await makeCourse("search", [{ required: true, published: true }]);
  const zoe = await makeUser("Zoe Percent", `100%sure_${uid()}@example.test`);
  const zoeEnroll = await enroll(zoe, course.id);
  const bob = await makeUser("Bob Underscore", `bob_doe_${uid()}@example.test`);
  await enroll(bob, course.id);

  cookieHeader = adminCookie;
  const byName = (await listCourseLearners(course.id, { q: "  ZOE " })).rows;
  assert.equal(byName.length, 1);
  assert.equal(byName[0].enrollmentId, zoeEnroll);
  // Literal %: matches Zoe only (no wildcard expansion onto Bob).
  const byPercent = (await listCourseLearners(course.id, { q: "100%sure" })).rows;
  assert.deepEqual(byPercent.map((r) => r.enrollmentId), [zoeEnroll]);
  // Literal _: "bob_doe" must not match "bobXdoe"-style rows; here it finds Bob.
  const byUnder = (await listCourseLearners(course.id, { q: "bob_doe" })).rows;
  assert.equal(byUnder.length, 1);
  // Over-long queries are truncated, not rejected.
  const long = await listCourseLearners(course.id, { q: "x".repeat(200) });
  assert.equal(long.rows.length, 0);
});

test("pagination fetches page-size+1: 26 rows spill onto page 2", async () => {
  cookieHeader = adminCookie;
  const { course } = await makeCourse("paging", [{ required: true, published: true }]);
  for (let n = 0; n < 26; n++) {
    const id = await makeUser(`Page Learner ${n}`, `page-${n}-${uid()}@example.test`);
    await enroll(id, course.id);
  }
  cookieHeader = adminCookie;
  const realD1 = await getD1Database();
  let selects = 0;
  setD1DatabaseForTest({
    prepare(sql: string) {
      if (/^\s*(select|with)/i.test(sql) && /enrollments|lesson_progress|quiz_attempts|lessons|certificates/i.test(sql)) selects++;
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
  try {
    const first = await listCourseLearners(course.id, { page: 1 });
    assert.equal(first.rows.length, LEARNERS_PAGE_SIZE);
    assert.equal(first.hasNextPage, true);
    const second = await listCourseLearners(course.id, { page: 2 });
    assert.equal(second.rows.length, 1);
    assert.equal(second.hasNextPage, false);
    assert.ok(!first.rows.some((r) => second.rows.some((o) => o.enrollmentId === r.enrollmentId)));
    assert.equal(selects, 2, "one SQL statement per page (plus no curriculum query)");
  } finally { clearD1DatabaseForTest(); }
});

test("lastActivityAt is the greatest of enrolment, progress and quiz timestamps", async () => {
  cookieHeader = adminCookie;
  const { course, lessonIds } = await makeCourse("activity", [{ required: true, published: true }]);
  const userId = await makeUser("Active Annie", `annie-${uid()}@example.test`);
  const enrollmentId = await enroll(userId, course.id, { enrolledAt: ago(30) });
  await complete(userId, enrollmentId, lessonIds[0], ago(5));

  // Quiz fixture without touching the quiz domain writes.
  cookieHeader = adminCookie;
  const { upsertLessonQuiz } = await import("../src/features/quizzes/service");
  const quiz = await upsertLessonQuiz({
    lessonId: lessonIds[0],
    passPercent: 70,
    requirePass: false,
    questions: [{
      id: "q1", prompt: "Prompt", kind: "single",
      options: [{ id: "o1", text: "One" }, { id: "o2", text: "Two" }],
      correctOptionIds: ["o1"], explanation: "Because.",
    }],
  });
  await attempt(userId, enrollmentId, quiz.id, lessonIds[0], false, ago(1));

  cookieHeader = adminCookie;
  const row = (await listCourseLearners(course.id, {})).rows[0];
  assert.equal(row.lastActivityAt.getTime(), secs(ago(1)));

  // No progress and no quiz: falls back to the enrolment date.
  const quietId = await makeUser("Quiet Quinn", `quinn-${uid()}@example.test`);
  const quietEnroll = await enroll(quietId, course.id, { enrolledAt: ago(9) });
  const quiet = (await listCourseLearners(course.id, {})).rows.find((r) => r.enrollmentId === quietEnroll)!;
  assert.equal(quiet.lastActivityAt.getTime(), secs(ago(9)));
});

test("revoked certificates do not count; dashboard attention aggregates correctly", async () => {
  cookieHeader = adminCookie;
  const { course, lessonIds } = await makeCourse("attention", [
    { required: true, published: true },
  ]);
  const { course: other } = await makeCourse("attention-other", [
    { required: true, published: true },
  ]);

  // Valid certificate holder (complete + unrevoked).
  const holder = await makeUser("Cert Holder", `holder-${uid()}@example.test`);
  const holderEnroll = await enroll(holder, course.id, { status: "completed", completedAt: ago(1) });
  await certify(holder, course.id, holderEnroll, false);
  // Revoked certificate holder.
  const revoked = await makeUser("Revoked Rita", `rita-${uid()}@example.test`);
  const revokedEnroll = await enroll(revoked, course.id, { status: "completed", completedAt: ago(1) });
  await certify(revoked, course.id, revokedEnroll, true);
  // Stuck learners: 3 on course (unique global max, so it wins topStuckCourseId
  // over the 2 stuck on the filters test's course), 1 on other.
  for (const c of [course.id, course.id, course.id, other.id]) {
    const id = await makeUser(`Stuck ${uid()}`, `stuck-${uid()}@example.test`);
    await enroll(id, c, { enrolledAt: ago(20) });
  }
  // Old completion outside the 7-day window (must not count).
  const oldId = await makeUser("Old Completer", `old-${uid()}@example.test`);
  await enroll(oldId, course.id, { status: "completed", completedAt: ago(8) });

  // Quiz failures: two failures on the same (user, quiz) count once; old and
  // passed attempts are excluded.
  cookieHeader = adminCookie;
  const { upsertLessonQuiz } = await import("../src/features/quizzes/service");
  const quiz = await upsertLessonQuiz({
    lessonId: lessonIds[0],
    passPercent: 70,
    requirePass: false,
    questions: [{
      id: "q1", prompt: "Prompt", kind: "single",
      options: [{ id: "o1", text: "One" }, { id: "o2", text: "Two" }],
      correctOptionIds: ["o1"], explanation: "Because.",
    }],
  });
  const failer = await makeUser("Failing Finn", `finn-${uid()}@example.test`);
  const failerEnroll = await enroll(failer, course.id);
  await attempt(failer, failerEnroll, quiz.id, lessonIds[0], false, ago(1));
  await attempt(failer, failerEnroll, quiz.id, lessonIds[0], false, ago(2));
  const passer = await makeUser("Passing Pam", `pam-${uid()}@example.test`);
  const passerEnroll = await enroll(passer, course.id);
  await attempt(passer, passerEnroll, quiz.id, lessonIds[0], true, ago(1));
  const oldFailer = await makeUser("Old Failer", `oldfail-${uid()}@example.test`);
  const oldFailerEnroll = await enroll(oldFailer, course.id);
  await attempt(oldFailer, oldFailerEnroll, quiz.id, lessonIds[0], false, ago(10));

  cookieHeader = adminCookie;
  const byId = new Map((await listCourseLearners(course.id, { filter: "completed" })).rows.map((r) => [r.enrollmentId, r]));
  assert.equal(byId.get(holderEnroll)?.hasCertificate, true);
  assert.equal(byId.get(revokedEnroll)?.hasCertificate, false);

  const realD1 = await getD1Database();
  let serviceQueries = 0;
  setD1DatabaseForTest({
    prepare(sql: string) {
      if (/^\s*(select|with)/i.test(sql) && /enrollments|quiz_attempts|lesson_progress|lessons|certificates/i.test(sql)) serviceQueries++;
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
  let attention;
  try {
    attention = await getStudioLearnerAttention(new Date());
    assert.ok(serviceQueries <= 3, `attention must use at most 3 queries, used ${serviceQueries}`);
  } finally { clearD1DatabaseForTest(); }
  assert.equal(attention!.stuck, 6, "2 from the filters fixture + 4 created here");
  assert.equal(attention!.completedThisWeek, 3, "filters done (2d) + holder + revoked (1d); 8-day-old excluded");
  assert.equal(attention!.quizFailuresThisWeek, 2, "Active Annie (prior test) + Finn; dupes, passes and old attempts excluded");
  assert.equal(attention!.topStuckCourseId, course.id);
});

test("CSV helpers quote per RFC 4180 and neutralize formula injection", () => {
  assert.equal(toCsvCell("plain"), "plain");
  assert.equal(toCsvCell("a,b"), '"a,b"');
  assert.equal(toCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(toCsvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(toCsvCell("=2+2"), "'=2+2");
  assert.equal(toCsvCell("+cmd"), "'+cmd");
  assert.equal(toCsvCell("-2"), "'-2");
  assert.equal(toCsvCell("@mention"), "'@mention");
  assert.equal(toCsvCell("\tindented"), "'\tindented");
  // CR forces RFC quoting on top of the injection guard.
  assert.equal(toCsvCell("\rreturn"), "\"'\rreturn\"");
  // Injection prefix composes with quoting when the cell also needs quotes.
  assert.equal(toCsvCell("=a,b"), "\"'=a,b\"");
  assert.equal(toCsvCell(38), "38");
  assert.equal(toCsvCell(null), "");
  assert.equal(toCsvRow(["a", "b,c"]), "a,\"b,c\"\r\n");
  const doc = buildCsv(["name", "email"], [["Zoe", "zoe@example.test"]]);
  assert.equal(doc, "name,email\r\nZoe,zoe@example.test\r\n");
});

test("export returns CSV with attachment + no-store headers and writes one audit row", async () => {
  cookieHeader = adminCookie;
  const { course } = await makeCourse("export", [{ required: true, published: true }]);
  const tricky = await makeUser('=Evil, "Quoted"', `evil+${uid()}@example.test`);
  await enroll(tricky, course.id);
  const db = await getDb();
  const auditsBefore = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "course"), eq(adminAuditLog.entityId, course.id)));

  cookieHeader = adminCookie;
  const res = await exportRoute.GET(
    new Request(`https://studio.test/admin/courses/${course.id}/learners/export?filter=all`),
    { params: Promise.resolve({ courseId: course.id }) },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const disposition = res.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename="learners-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv"$/);
  const body = await res.text();
  const lines = body.split("\r\n").filter(Boolean);
  assert.equal(lines[0], "name,email,status,progress_percent,lessons_completed,lessons_required,enrolled_at,last_activity_at,completed_at,left_at,certificate");
  const trickyLine = lines.find((l) => l.includes("evil+"));
  assert.ok(trickyLine, "tricky learner row present");
  assert.ok(trickyLine!.includes("'=Evil,"), `formula-injected name guarded, got: ${trickyLine}`);

  const auditsAfter = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "course"), eq(adminAuditLog.entityId, course.id)));
  assert.equal(auditsAfter.length, auditsBefore.length + 1);
  const audit = auditsAfter[auditsAfter.length - 1];
  assert.equal(audit.action, "learners.export");
  assert.equal(audit.actorId, adminId);
  const details = JSON.parse(audit.details!);
  assert.equal(details.filter, "all");
  assert.equal(details.rows, 1);
  assert.ok(!JSON.stringify(details).includes("evil+"), "no emails in audit details");

  // Unknown course → 404.
  const missing = await exportRoute.GET(
    new Request("https://studio.test/admin/courses/nope/learners/export"),
    { params: Promise.resolve({ courseId: "nope" }) },
  );
  assert.equal(missing.status, 404);
});
