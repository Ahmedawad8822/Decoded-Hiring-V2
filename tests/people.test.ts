/**
 * PEOPLE (Batch I — "Know your people")
 * ---------------------------------------------------------------------------
 * - Quiz option tags: schema (valid/invalid/legacy), Studio save with tags,
 *   submission awards tags idempotently, learner payload + graded result never
 *   contain any tag.
 * - Admin-only people services, actions and CSV export (401/403 without audit).
 * - Admin add/remove tag + audit; note save / 5000-char cap / clear / audit
 *   without the body.
 * - Profile aggregates: bookings + leads matched case-insensitively by email,
 *   orders by user id or customer email, emails show subjects only.
 * - Timeline merged + date-sorted in memory; list search/tag/pagination;
 *   Learners-tab tag filter; CSV headers + audit.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import "./helpers/env"; // MUST be first: throwaway DH_LOCAL_STATE_DIR + test secret.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import {
  adminAuditLog,
  bookingTypes,
  bookings,
  certificates,
  emailOutbox,
  enrollments,
  getDb,
  leadSubmissions,
  learnerTags,
  offers,
  orders,
  quizAttempts,
  slotHolds,
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
import { enrollFree } from "../src/features/enrollments/service";
import { generateCertificateId } from "../src/features/certificates/types";
import {
  getPersonProfile,
  listAllPeopleForExport,
  listPeople,
  addPersonTag,
  removePersonTag,
  savePersonNote,
} from "../src/features/people/service";
import {
  parseQuizQuestions,
  quizQuestionsSchema,
  toLearnerQuiz,
} from "../src/features/quizzes/types";
import { upsertLessonQuiz, submitQuizAttempt } from "../src/features/quizzes/service";

process.env.ADMIN_REQUIRE_2FA = "false";
const nodeRequire = createRequire(__filename);
let cookieHeader = "";
let learnerCookie = "";
let adminCookie = "";
let learnerId = "";
let adminId = "";
let peopleActions: typeof import("../src/features/people/actions");
let peopleExportRoute: typeof import("../src/app/admin/people/export/route");

const uid = () => crypto.randomUUID().slice(0, 8);
const DAY_MS = 86400000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS);

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
  const email = `person-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({
    body: { email, password, name: "Person Fixture" },
  });
  if (admin) await (await getDb()).update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return {
    id: created.user.id,
    email,
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

async function makeCourse(slug: string) {
  cookieHeader = adminCookie;
  const course = await createCourse({ title: `Course ${slug}`, slug: `people-${slug}-${uid()}` });
  const section = await createSection({ courseId: course.id, title: "Section" });
  const lesson = await createLesson({
    courseId: course.id, sectionId: section.id,
    title: "Lesson", slug: `lesson-${uid()}`, required: true,
  });
  await publishLesson(lesson.id);
  await publishCourse(course.id);
  return { course, lesson };
}

async function enroll(userId: string, courseId: string, enrolledAt = new Date()) {
  const db = await getDb();
  const id = `enroll_${uid()}`;
  await db.insert(enrollments).values({
    id, userId, courseId, status: "active", accessSource: "free", enrolledAt,
  });
  return id;
}

/** Single upsert: input ids only need to be self-consistent (server remaps them). */
async function makeTaggedQuiz(lessonId: string) {
  return upsertLessonQuiz({
    lessonId,
    passPercent: 50,
    requirePass: false,
    questions: [
      {
        prompt: "Pick a path",
        kind: "single" as const,
        options: [
          { id: "in-a", text: "Alpha", tag: "wants-alpha" },
          { id: "in-b", text: "Beta", tag: "" },
        ],
        correctOptionIds: ["in-a"],
        explanation: "Alpha wins.",
      },
      {
        prompt: "Pick many",
        kind: "multiple" as const,
        options: [
          { id: "in-c", text: "Gamma", tag: "WANTS-GAMMA" },
          { id: "in-d", text: "Delta" },
        ],
        correctOptionIds: ["in-c"],
      },
    ],
  });
}

async function clearThrottle(userId: string, quizId: string) {
  const db = await getDb();
  await db
    .update(quizAttempts)
    .set({ createdAt: new Date(Date.now() - 6000) })
    .where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId)));
}

async function personAudits(userId: string, action: string) {
  const db = await getDb();
  return db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "person"), eq(adminAuditLog.entityId, userId), eq(adminAuditLog.action, action)));
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn });
  const learner = await account(false);
  learnerId = learner.id;
  learnerCookie = learner.cookie;
  const admin = await account(true);
  adminId = admin.id;
  adminCookie = admin.cookie;
  cookieHeader = adminCookie;
  peopleActions = await import("../src/features/people/actions");
  peopleExportRoute = await import("../src/app/admin/people/export/route");
});
test.after(async () => { await disposeCloudflareBindings(); });

// ---------------------------------------------------------------------------
// Access gates

test("non-admin callers are refused everywhere without audit rows", async () => {
  cookieHeader = adminCookie;
  const targetId = await makeUser("Gate Target", `gate-${uid()}@example.test`);
  const db = await getDb();
  const before = await db.select().from(adminAuditLog).where(eq(adminAuditLog.entityType, "person"));

  for (const cookie of ["", learnerCookie]) {
    cookieHeader = cookie;
    await assert.rejects(() => listPeople({}), /Unauthorized|Forbidden/);
    await assert.rejects(() => listAllPeopleForExport({}), /Unauthorized|Forbidden/);
    await assert.rejects(() => getPersonProfile(targetId), /Unauthorized|Forbidden/);
    await assert.rejects(() => addPersonTag(targetId, "x"), /Unauthorized|Forbidden/);
    await assert.rejects(() => removePersonTag(targetId, "x"), /Unauthorized|Forbidden/);
    await assert.rejects(() => savePersonNote(targetId, "hi", adminId), /Unauthorized|Forbidden/);
    assert.equal((await peopleActions.addPersonTagAction({ userId: targetId, tag: "x" })).ok, false);
    assert.equal((await peopleActions.removePersonTagAction({ userId: targetId, tag: "x" })).ok, false);
    assert.equal((await peopleActions.savePersonNoteAction({ userId: targetId, body: "hi" })).ok, false);
    const res = await peopleExportRoute.GET(new Request("https://studio.test/admin/people/export"));
    assert.ok(res.status === 401 || res.status === 403);
  }
  cookieHeader = adminCookie;
  // The auth-created learner fixture is a plain role-user person: visible.
  assert.ok((await getPersonProfile(learnerId))?.user.email.endsWith("@example.test"));
  const after = await db.select().from(adminAuditLog).where(eq(adminAuditLog.entityType, "person"));
  assert.equal(after.length, before.length, "refused calls write no audit rows");
});

// ---------------------------------------------------------------------------
// Quiz option tags

test("quiz tag schema accepts valid slugs, normalizes case, rejects bad slugs", () => {
  const base = {
    id: "q1", prompt: "P", kind: "single" as const,
    options: [
      { id: "o1", text: "One" },
      { id: "o2", text: "Two" },
    ],
    correctOptionIds: ["o1"],
  };
  // Old quizzes without tags keep parsing; the field normalizes to undefined.
  const legacy = parseQuizQuestions(JSON.stringify([base]));
  assert.ok(legacy);
  assert.equal(legacy[0].options[0].tag, undefined);

  assert.equal(
    quizQuestionsSchema.safeParse([{ ...base, options: [{ id: "o1", text: "One", tag: "wants-alpha" }, base.options[1]] }]).success,
    true,
  );
  // Uppercase is normalized, not rejected.
  const upper = quizQuestionsSchema.safeParse([{ ...base, options: [{ id: "o1", text: "One", tag: "WANTS-ALPHA" }, base.options[1]] }]);
  assert.equal(upper.success, true);
  if (upper.success) assert.equal(upper.data[0].options[0].tag, "wants-alpha");
  // Blank input normalizes to absent.
  const blank = quizQuestionsSchema.safeParse([{ ...base, options: [{ id: "o1", text: "One", tag: "  " }, base.options[1]] }]);
  assert.equal(blank.success, true);
  if (blank.success) assert.equal(blank.data[0].options[0].tag, undefined);

  for (const bad of ["Bad Tag!", "has space", "under_score", "x".repeat(41), "-leading"]) {
    assert.equal(
      quizQuestionsSchema.safeParse([{ ...base, options: [{ id: "o1", text: "One", tag: bad }, base.options[1]] }]).success,
      false,
      `tag ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("submission awards tags idempotently and never leaks them to the learner", async () => {
  cookieHeader = adminCookie;
  const { course, lesson } = await makeCourse("tagaward");
  const quiz = await makeTaggedQuiz(lesson.id);
  assert.equal(quiz.questions[0].options[0].tag, "wants-alpha");
  assert.equal(quiz.questions[1].options[0].tag, "wants-gamma");

  const userId = await makeUser("Tag Award", `award-${uid()}@example.test`);
  await enrollFree(userId, course.id);
  const answers = Object.fromEntries(
    quiz.questions.map((question) => [question.id, [question.options[0].id]]),
  );

  const result = await submitQuizAttempt(userId, {
    courseSlug: course.slug, lessonSlug: lesson.slug, answers,
  });
  assert.equal(result.passed, true);

  const db = await getDb();
  const tags = async () =>
    db.select().from(learnerTags).where(eq(learnerTags.userId, userId));
  assert.deepEqual(
    (await tags()).map((t) => t.tag).sort(),
    ["wants-alpha", "wants-gamma"],
  );
  const first = await tags();
  assert.ok(first.every((t) => t.source === "quiz"));
  assert.ok(first.every((t) => t.sourceQuizId === quiz.id));

  // Re-submission (and in-batch duplicates) stay idempotent.
  await clearThrottle(userId, quiz.id);
  await submitQuizAttempt(userId, { courseSlug: course.slug, lessonSlug: lesson.slug, answers });
  assert.equal((await tags()).length, 2);

  // The graded result carries answers/explanations but never tags.
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('"tag"'), "submission result must not contain tags");
  assert.ok(serialized.includes("correctOptionIds"), "grading feedback itself is intact");

  // The pre-submission projection never carries tags either.
  cookieHeader = adminCookie;
  const { getLearnerQuizForLesson } = await import("../src/features/quizzes/service");
  const projected = await getLearnerQuizForLesson(lesson.id);
  assert.ok(projected);
  assert.ok(!JSON.stringify(projected).includes('"tag"'));
  assert.ok(!JSON.stringify(toLearnerQuiz(quiz)).includes('"tag"'));
});

test("admin tag wins over a later quiz tag; unselected options award nothing", async () => {
  cookieHeader = adminCookie;
  const { course, lesson } = await makeCourse("tagwin");
  const quiz = await makeTaggedQuiz(lesson.id);
  const userId = await makeUser("Tag Winner", `winner-${uid()}@example.test`);

  // Admin tags first with the same slug the quiz would award.
  cookieHeader = adminCookie;
  assert.equal((await peopleActions.addPersonTagAction({ userId, tag: "wants-alpha" })).ok, true);
  const db = await getDb();
  const before = await db.select().from(learnerTags).where(eq(learnerTags.userId, userId));
  assert.equal(before[0].source, "admin");

  await enrollFree(userId, course.id);
  // Select only the second question's tagged option.
  const answers = { [quiz.questions[1].id]: [quiz.questions[1].options[0].id] };
  await submitQuizAttempt(userId, { courseSlug: course.slug, lessonSlug: lesson.slug, answers });
  const after = await db.select().from(learnerTags).where(eq(learnerTags.userId, userId));
  assert.deepEqual(after.map((t) => t.tag).sort(), ["wants-alpha", "wants-gamma"]);
  assert.equal(after.find((t) => t.tag === "wants-alpha")!.source, "admin");
});

// ---------------------------------------------------------------------------
// Tags + notes through the admin actions

test("admin add/remove tag writes audits; unknown and admin ids are refused", async () => {
  cookieHeader = adminCookie;
  const userId = await makeUser("Tag Subject", `subject-${uid()}@example.test`);

  const added = await peopleActions.addPersonTagAction({ userId, tag: "  OnboARding  " });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.data?.tag, "onboarding");

  cookieHeader = adminCookie;
  const profile = await getPersonProfile(userId);
  assert.deepEqual(profile!.tags.map((t) => t.tag), ["onboarding"]);
  assert.equal(profile!.tags[0].source, "admin");

  const addAudits = await personAudits(userId, "person.tag_add");
  assert.equal(addAudits.length, 1);
  assert.equal(addAudits[0].actorId, adminId);
  assert.deepEqual(JSON.parse(addAudits[0].details!), { tag: "onboarding" });

  // Invalid slugs and unknown/admin ids are refused.
  assert.equal((await peopleActions.addPersonTagAction({ userId, tag: "no good!" })).ok, false);
  assert.equal((await peopleActions.addPersonTagAction({ userId: "missing", tag: "x" })).ok, false);
  assert.equal((await peopleActions.addPersonTagAction({ userId: adminId, tag: "x" })).ok, false);
  assert.equal(await getPersonProfile("missing"), null);
  assert.equal(await getPersonProfile(adminId), null);

  const removed = await peopleActions.removePersonTagAction({ userId, tag: "onboarding" });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.deepEqual((await getPersonProfile(userId))!.tags, []);
  const removeAudits = await personAudits(userId, "person.tag_remove");
  assert.equal(removeAudits.length, 1);
  assert.deepEqual(JSON.parse(removeAudits[0].details!), { tag: "onboarding" });
});

test("note save, length cap, clear and body-free audit", async () => {
  cookieHeader = adminCookie;
  const userId = await makeUser("Note Subject", `note-${uid()}@example.test`);
  const secret = `SECRET-NOTE-${uid()}`;

  const saved = await peopleActions.savePersonNoteAction({ userId, body: "  Remembers birthdays  " });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.data?.cleared, false);

  cookieHeader = adminCookie;
  assert.equal((await getPersonProfile(userId))!.note?.body, "Remembers birthdays");

  const audits = await personAudits(userId, "person.note_save");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorId, adminId);
  assert.ok(
    audits[0].details === null || !JSON.stringify(audits[0].details).includes("birthdays"),
    "audit details must never carry the note body",
  );

  // Over the cap is refused and the stored note is untouched.
  assert.equal(
    (await peopleActions.savePersonNoteAction({ userId, body: `${secret} ${"x".repeat(5000)}` })).ok,
    false,
  );
  assert.equal((await getPersonProfile(userId))!.note?.body, "Remembers birthdays");

  // Empty body clears the note (audited as a save).
  assert.equal((await peopleActions.savePersonNoteAction({ userId, body: "   " })).ok, true);
  assert.equal((await getPersonProfile(userId))!.note, null);
  assert.equal((await personAudits(userId, "person.note_save")).length, 2);
});

// ---------------------------------------------------------------------------
// Profile aggregates

async function makeBooking(email: string, createdAt: Date) {
  const db = await getDb();
  const typeId = `bt_${uid()}`;
  await db.insert(bookingTypes).values({
    id: typeId, slug: `bt-${uid()}`, title: "Intro Call",
    durationMinutes: 30, bookingHorizonDays: 30, timezone: "UTC",
    createdAt, updatedAt: createdAt,
  });
  const holdId = `hold_${uid()}`;
  const at = new Date(createdAt.getTime() + DAY_MS);
  await db.insert(slotHolds).values({
    id: holdId, bookingTypeId: typeId, slotKey: `slot-${uid()}`,
    startAt: at, endAt: new Date(at.getTime() + 30 * 60000),
    ownerToken: `tok-${uid()}`, expiresAt: new Date(Date.now() + DAY_MS),
    createdAt, updatedAt: createdAt,
  });
  const id = `book_${uid()}`;
  await db.insert(bookings).values({
    id, bookingTypeId: typeId, holdId, holdAcquisitionKey: `acq-${uid()}`,
    requestKey: `req-${uid()}`, requesterName: "Case Person", requesterEmail: email,
    slotKey: `slot-${uid()}`, startAt: at, endAt: new Date(at.getTime() + 30 * 60000),
    timezone: "UTC", createdAt, updatedAt: createdAt,
  });
  return id;
}

async function makeOrder(opts: { userId?: string | null; email: string; createdAt: Date }) {
  const db = await getDb();
  const offerId = `offer_${uid()}`;
  await db.insert(offers).values({
    id: offerId, kind: "PRODUCT", title: "Hiring Audit", slug: `offer-${uid()}`, accessMode: "FREE",
    createdAt: opts.createdAt, updatedAt: opts.createdAt,
  });
  const id = `order_${uid()}`;
  await db.insert(orders).values({
    id, offerId, offerKind: "PRODUCT", accessMode: "FREE",
    requestKey: `req-${uid()}`, customerEmail: opts.email,
    userId: opts.userId ?? null, createdAt: opts.createdAt, updatedAt: opts.createdAt,
  });
  return id;
}

async function makeLead(email: string, createdAt: Date) {
  const db = await getDb();
  const id = `lead_${uid()}`;
  await db.insert(leadSubmissions).values({
    id, idempotencyKey: `idem-${uid()}`, kind: "contact", status: "NEW",
    fullName: "Case Person", email, countryCode: "US",
    sourceRoute: "/contact", privacyAcknowledged: true,
    createdAt, updatedAt: createdAt,
  });
  return id;
}

async function makeEmail(to: string, subject: string, createdAt: Date, sentAt: Date | null) {
  const db = await getDb();
  const id = `email_${uid()}`;
  await db.insert(emailOutbox).values({
    id, kind: "enrollment_welcome", toAddress: to, subject,
    textBody: `SECRET-BODY-${uid()}`, status: sentAt ? "sent" : "pending",
    nextAttemptAt: new Date(Date.now() + DAY_MS), expiresAt: new Date(Date.now() + 7 * DAY_MS),
    createdAt, sentAt,
  });
  return id;
}

test("profile aggregates bookings/leads case-insensitively and orders by id or email", async () => {
  cookieHeader = adminCookie;
  const email = `Case-Person-${uid()}@Example.TEST`;
  const userId = await makeUser("Case Person", email);

  // Mixed-case counterparts must still match (lower() on both sides).
  await makeBooking(email.toUpperCase(), ago(5));
  await makeBooking(`other-${uid()}@example.test`, ago(5));
  const leadId = await makeLead(`  ${email.toLowerCase()}  `.trim().toUpperCase(), ago(3));
  void leadId;
  await makeLead(`other-${uid()}@example.test`, ago(3));
  const byId = await makeOrder({ userId, email: `different-${uid()}@example.test`, createdAt: ago(2) });
  void byId;
  const otherUser = await makeUser("Other", `other-${uid()}@example.test`);
  const byEmail = await makeOrder({ userId: otherUser, email: email.toLowerCase(), createdAt: ago(1) });
  void byEmail;
  const otherOrder = await makeOrder({ userId: otherUser, email: `other-${uid()}@example.test`, createdAt: ago(1) });
  void otherOrder;

  cookieHeader = adminCookie;
  const profile = await getPersonProfile(userId);
  assert.ok(profile);
  assert.equal(profile.bookings.length, 1);
  assert.equal(profile.bookings[0].bookingTypeTitle, "Intro Call");
  assert.equal(profile.leads.length, 1);
  assert.equal(profile.leads[0].kind, "contact");
  assert.deepEqual(profile.orders.map((o) => o.id).sort(), [byId, byEmail].sort());
});

test("timeline merges every section newest-first; emails expose no bodies", async () => {
  cookieHeader = adminCookie;
  const email = `timeline-${uid()}@example.test`;
  const userId = await makeUser("Timeline Tess", email);
  const { course, lesson } = await makeCourse("timeline");
  const enrollmentId = await enroll(userId, course.id, ago(10));

  const db = await getDb();
  const quiz = await upsertLessonQuiz({
    lessonId: lesson.id, passPercent: 70, requirePass: false,
    questions: [{
      id: "tq", prompt: "Prompt", kind: "single",
      options: [{ id: "to-a", text: "One" }, { id: "to-b", text: "Two" }],
      correctOptionIds: ["to-a"],
    }],
  });
  await db.insert(quizAttempts).values({
    id: `att_${uid()}`, quizId: quiz.id, userId, enrollmentId,
    lessonId: lesson.id, answers: "{}",
    scorePercent: 0, correctCount: 0, totalCount: 1, passed: false, createdAt: ago(7),
  });
  await db.insert(certificates).values({
    id: generateCertificateId(), userId, courseId: course.id, enrollmentId,
    recipientName: "Timeline Tess", courseTitle: "Timeline Course", issuedAt: ago(6),
  });
  await makeBooking(email, ago(5));
  await makeOrder({ userId, email, createdAt: ago(4) });
  await makeLead(email, ago(3));
  const emailSubject = `Welcome subject ${uid()}`;
  await makeEmail(email, emailSubject, ago(2), ago(1));

  cookieHeader = adminCookie;
  const profile = await getPersonProfile(userId);
  assert.ok(profile);
  assert.equal(profile.emails.length, 1);
  assert.equal(profile.emails[0].subject, emailSubject);
  assert.ok(
    !JSON.stringify(profile).includes("SECRET-BODY"),
    "profile payload must never include email bodies",
  );
  assert.ok(!("textBody" in profile.emails[0]) && !("htmlBody" in profile.emails[0]));

  const labels = profile.timeline.map((t) => t.label);
  assert.equal(profile.timeline.length, 7);
  assert.deepEqual(labels, [
    `Email Welcome — ${emailSubject}`,
    "Lead — contact",
    `Order PENDING — Hiring Audit`,
    "Booking REQUESTED — Intro Call",
    "Certificate issued for Timeline Course",
    "Quiz failed — Lesson (0%)",
    `Enrolled in ${course.title}`,
  ]);
  for (let i = 1; i < profile.timeline.length; i++) {
    assert.ok(
      profile.timeline[i - 1].date.getTime() >= profile.timeline[i].date.getTime(),
      "timeline must be newest-first",
    );
  }
  assert.ok(profile.timeline.length <= 50);
});

// ---------------------------------------------------------------------------
// List: search, tag filter, pagination

test("people list searches literally, filters by tag and paginates 25+1", async () => {
  cookieHeader = adminCookie;
  const prefix = `Paging-${uid()}`;
  const ids: string[] = [];
  for (let n = 0; n < 26; n++) {
    const id = await makeUser(`${prefix} Learner ${n}`, `${prefix.toLowerCase()}-${n}-${uid()}@example.test`);
    ids.push(id);
  }
  await addPersonTag(ids[0], "vip");

  cookieHeader = adminCookie;
  // Scoped search: 26 rows spill onto page 2.
  const first = await listPeople({ q: prefix, page: 1 });
  assert.equal(first.rows.length, 25);
  assert.equal(first.hasNextPage, true);
  const second = await listPeople({ q: prefix, page: 2 });
  assert.equal(second.rows.length, 1);
  assert.equal(second.hasNextPage, false);

  // Literal %/_ search: no LIKE wildcards.
  const tricky = await makeUser("100%Sure_Bob", `sure-${uid()}@example.test`);
  void tricky;
  assert.equal((await listPeople({ q: "100%Sure_Bob" })).rows.length, 1);
  assert.equal((await listPeople({ q: "100%Sure" })).rows.length, 1);

  // Tag filter: exact slug only.
  const tagged = await listPeople({ q: prefix, tag: "VIP" });
  assert.equal(tagged.rows.length, 1);
  assert.deepEqual(tagged.rows[0].tags, ["vip"]);
  assert.equal((await listPeople({ q: prefix, tag: "vip " })).rows.length, 1);
  assert.equal((await listPeople({ q: prefix, tag: "nope" })).rows.length, 0);

  // One query for the list (auth session lookups excluded by table filter).
  const realD1 = await getD1Database();
  let selects = 0;
  setD1DatabaseForTest({
    prepare(sql: string) {
      if (/^\s*select/i.test(sql) && /FROM "user" u/i.test(sql)) selects++;
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
  try {
    await listPeople({ q: prefix });
    assert.equal(selects, 1, "people list must run ONE statement");
  } finally { clearD1DatabaseForTest(); }

  // No-enrollment people fall back to their join date for activity.
  const quiet = first.rows.find((r) => r.enrollmentCount === 0)!;
  assert.ok(quiet);
  assert.equal(quiet.lastActivityAt.getTime(), quiet.joinedAt.getTime());
});

test("profile runs a bounded handful of queries", async () => {
  cookieHeader = adminCookie;
  const userId = await makeUser("Budget Bob", `budget-${uid()}@example.test`);
  const realD1 = await getD1Database();
  let selects = 0;
  setD1DatabaseForTest({
    prepare(sql: string) {
      if (/^\s*select/i.test(sql) && /learner_tags|admin_person_notes|enrollments|quiz_attempts|certificates|bookings|orders|lead_submissions|email_outbox/i.test(sql)) selects++;
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as unknown as Parameters<typeof setD1DatabaseForTest>[0]);
  try {
    await getPersonProfile(userId);
    assert.ok(selects <= 9, `profile must stay bounded (one user lookup + 8 sections), used ${selects}`);
  } finally { clearD1DatabaseForTest(); }
});

// ---------------------------------------------------------------------------
// Learners-tab tie-in + CSV export

test("learners tab tag filter scopes to tagged enrollments", async () => {
  const { listCourseLearners } = await import("../src/features/learners/service");
  cookieHeader = adminCookie;
  const { course } = await makeCourse("tagfilter");
  const taggedId = await makeUser("Tagged Tab", `tabbed-${uid()}@example.test`);
  const plainId = await makeUser("Plain Tab", `plain-${uid()}@example.test`);
  await enroll(taggedId, course.id);
  await enroll(plainId, course.id);
  await addPersonTag(taggedId, "cohort-a");

  cookieHeader = adminCookie;
  const filtered = await listCourseLearners(course.id, { tag: "COHORT-A" });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].userId, taggedId);
  assert.equal((await listCourseLearners(course.id, {})).rows.length, 2);
  assert.equal((await listCourseLearners(course.id, { tag: "missing" })).rows.length, 0);
});

test("people export returns CSV with attachment + no-store and one audit row", async () => {
  cookieHeader = adminCookie;
  const marker = `Export-${uid()}`;
  const userId = await makeUser(`${marker} Person`, `${marker.toLowerCase()}-${uid()}@example.test`);
  await addPersonTag(userId, "export-me");
  const db = await getDb();
  const auditsBefore = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "person"), eq(adminAuditLog.entityId, "all")));

  cookieHeader = adminCookie;
  const res = await peopleExportRoute.GET(
    new Request(`https://studio.test/admin/people/export?tag=export-me`),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const disposition = res.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename="people-\d{4}-\d{2}-\d{2}\.csv"$/);
  const body = await res.text();
  const lines = body.split("\r\n").filter(Boolean);
  assert.equal(lines[0], "name,email,joined_at,enrollment_count,tags,last_activity_at");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes("export-me"));
  assert.ok(!body.includes("other-"), "export respects the tag filter");

  const auditsAfter = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityType, "person"), eq(adminAuditLog.entityId, "all")));
  assert.equal(auditsAfter.length, auditsBefore.length + 1);
  const audit = auditsAfter[auditsAfter.length - 1];
  assert.equal(audit.action, "people.export");
  assert.equal(audit.actorId, adminId);
  const details = JSON.parse(audit.details!);
  assert.equal(details.filter, "export-me");
  assert.equal(details.rows, 1);
});
