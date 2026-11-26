/**
 * TRASH, ARCHIVE RESTORE AND PERMANENT DELETE (§1 lifecycle).
 *
 * Covers the shared transition table, archive restore for each type,
 * move-to-Trash / restore-from-Trash, permanent delete with dependency
 * protection, 30-day auto-purge, Trash invisibility across public/learner/
 * Studio/sitemap surfaces, typed-title confirmation, admin audit rows, and
 * admin-only authorization for the trash server actions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
import { markEmailVerified } from "./helpers/verified";
// These admins have no 2FA enrolled; the 2FA gate itself is covered by
// tests/admin-two-factor.test.ts.
process.env.ADMIN_REQUIRE_2FA = "false";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import {
  adminAuditLog,
  certificates,
  courses,
  courseSections,
  fieldNoteRevisions,
  getDb,
  guides,
  lessonNotes,
  lessonProgress,
  lessonQuestions,
  lessonQuizzes,
  lessonResources,
  lessons,
  offers,
  orders,
  quizAttempts,
  slugRedirects,
  users,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import {
  assertCourseTransition,
  assertGuideTransition,
  assertLessonTransition,
  assertFieldNoteTransition,
  assertTrashable,
  buildRestoreFromTrashUpdate,
  daysLeftBeforePurge,
  isTrashExpired,
  TRASH_RETENTION_DAYS,
} from "../src/features/publishing/lifecycle";
import {
  archiveGuide,
  createGuide,
  deleteGuidePermanently,
  getAdminGuideById,
  getAllAdminGuides,
  getPublishedGuides,
  getPublicGuideBySlug,
  publishGuide,
  restoreGuideFromArchive,
  restoreGuideFromTrash,
  trashGuide,
  updateGuide,
} from "../src/features/guides/service";
import {
  archiveFieldNote,
  createFieldNote,
  deleteFieldNotePermanently,
  getAdminFieldNoteById,
  getAllAdminFieldNotes,
  getPublishedFieldNotes,
  getPublicFieldNoteBySlug,
  publishFieldNote,
  restoreFieldNoteFromArchive,
  restoreFieldNoteFromTrash,
  trashFieldNote,
} from "../src/features/field-notes/service";
import {
  archiveCourse,
  archiveLesson,
  assertCourseDeletable,
  assertLessonDeletable,
  createCourse,
  createLesson,
  createSection,
  deleteCoursePermanently,
  deleteLessonPermanently,
  getAdminCourseById,
  getAdminLessonById,
  getAllAdminCourses,
  getCourseCurriculum,
  getLearnerCourseBySlug,
  getPublishedCourseBySlug,
  getPublishedCourses,
  getPublishedLessonBySlug,
  publishCourse,
  publishLesson,
  restoreCourseFromArchive,
  restoreCourseFromTrash,
  restoreLessonFromArchive,
  restoreLessonFromTrash,
  trashCourse,
  trashLesson,
  updateCourse,
} from "../src/features/courses/service";
import { enrollFree, cancelMyEnrollment } from "../src/features/enrollments/service";
import { createOffer } from "../src/features/offers/service";
import { uploadCourseResource } from "../src/lib/course-resources/service";
import { getR2Bucket } from "../src/lib/cloudflare/bindings";
import { getTrashableType, listTrash, purgeExpiredTrash } from "../src/features/trash/service";
import { resolveCourseRedirect, resolveGuideRedirect } from "../src/features/slug-redirects/service";
import { buildSitemapEntries } from "../src/lib/sitemap-entries";

const nodeRequire = createRequire(__filename);
let cookieHeader = "";
const revalidatedPaths: string[] = [];

/** Install stubs in require.cache BEFORE the app modules that import them load. */
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

type TrashActions = typeof import("../src/features/trash/actions");
let trashActions: TrashActions;

const uid = () => crypto.randomUUID().slice(0, 8);
let adminId = "";
let adminEmail = "";
const ADMIN_PASSWORD = "TrashTestPass123!";

async function createUser(emailPrefix: string, admin: boolean): Promise<{ id: string; email: string; password: string }> {
  const auth = await getAuth();
  const email = `${emailPrefix}-${uid()}@example.com`;
  const password = ADMIN_PASSWORD;
  const created = await auth.api.signUpEmail({ body: { email, password, name: emailPrefix } });
  const db = await getDb();
  if (admin) {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, created.user.id));
  }
  await markEmailVerified(created.user.id);
  return { id: created.user.id, email, password };
}

async function signInCookie(email: string, password: string): Promise<string> {
  const auth = await getAuth();
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", {
    revalidatePath: (path: string) => {
      revalidatedPaths.push(path);
    },
    revalidateTag: () => {},
    unstable_cache: <T>(fn: T) => fn,
  });
  trashActions = await import("../src/features/trash/actions");

  const admin = await createUser("trash-admin", true);
  adminId = admin.id;
  adminEmail = admin.email;
  cookieHeader = await signInCookie(admin.email, admin.password);
  assert.ok(cookieHeader, "admin sign-in must yield a session cookie");
});

test.after(async () => {
  await disposeCloudflareBindings();
});

// ---------------------------------------------------------------------------
// 1. Shared transition table
// ---------------------------------------------------------------------------

test("trash: shared lifecycle table allows restore from archived, keeps other archived actions rejected", () => {
  for (const assertFn of [assertGuideTransition, assertFieldNoteTransition, assertCourseTransition, assertLessonTransition]) {
    assert.doesNotThrow(() => assertFn("archived", "restore"));
    assert.throws(() => assertFn("archived", "publish"), /archived/i);
    assert.throws(() => assertFn("archived", "unpublish"), /archived/i);
    assert.throws(() => assertFn("archived", "archive"), /archived/i);
    assert.doesNotThrow(() => assertFn("draft", "publish"));
    assert.doesNotThrow(() => assertFn("published", "unpublish"));
  }
  assert.equal(TRASH_RETENTION_DAYS, 30);
});

test("trash: trash guards — published must unpublish/archive first, double-trash refused", () => {
  assert.throws(
    () => assertTrashable({ status: "published", trashedAt: null }),
    /Unpublish or archive before moving to Trash/
  );
  assert.doesNotThrow(() => assertTrashable({ status: "draft", trashedAt: null }));
  assert.doesNotThrow(() => assertTrashable({ status: "archived", trashedAt: null }));
  assert.throws(() => assertTrashable({ status: "draft", trashedAt: new Date() }), /already in Trash/);
  assert.throws(
    () => buildRestoreFromTrashUpdate({ status: "draft", trashedAt: null, trashedFromStatus: null }),
    /not in Trash/
  );
});

test("trash: retention helpers — 30 days left when fresh, expired after the window", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(daysLeftBeforePurge(now, now), 30);
  const old = new Date("2025-11-30T00:00:00Z"); // 32 days earlier
  assert.ok(daysLeftBeforePurge(old, now) < 0);
  assert.equal(isTrashExpired(old, now), true);
  assert.equal(isTrashExpired(now, now), false);
});

// ---------------------------------------------------------------------------
// 2. Guide lifecycle
// ---------------------------------------------------------------------------

test("trash: guide archive restores to draft, trash hides everywhere, restore returns status", async () => {
  const slug = `trash-guide-${uid()}`;
  const guide = await createGuide({ title: "Trash Guide", slug, author: "Studio", body: [] });
  await publishGuide(guide.id);
  const archived = await archiveGuide(guide.id);
  assert.equal(archived.status, "archived");

  const restored = await restoreGuideFromArchive(guide.id);
  assert.equal(restored.status, "draft");

  const trashed = await trashGuide(guide.id);
  assert.ok(trashed.trashedAt);
  assert.equal(trashed.trashedFromStatus, "draft");

  // Hidden from every normal list and public view (preview included).
  assert.ok(!(await getAllAdminGuides()).some((g) => g.id === guide.id));
  assert.ok(!(await getPublishedGuides()).some((g) => g.id === guide.id));
  assert.equal(await getPublicGuideBySlug(slug), null);
  assert.equal(await getPublicGuideBySlug(slug, { preview: true, session: { user: { id: adminId, role: "admin" } } }), null);

  // Lifecycle actions refuse trashed rows.
  await assert.rejects(() => publishGuide(guide.id), /in Trash/);
  await assert.rejects(() => archiveGuide(guide.id), /in Trash/);

  const untrashed = await restoreGuideFromTrash(guide.id);
  assert.equal(untrashed.status, "draft");
  assert.equal(untrashed.trashedAt, null);
  assert.ok((await getAllAdminGuides()).some((g) => g.id === guide.id));

  // Slug stays reserved while trashed: a second create on the same slug fails.
  await trashGuide(guide.id);
  await assert.rejects(() => createGuide({ title: "Squatter", slug, author: "Studio", body: [] }), /already exists/);
});

test("trash: guide permanent delete needs Trash + exact title, removes row and redirects", async () => {
  const slug = `trash-guide-del-${uid()}`;
  const guide = await createGuide({ title: "Delete Me Guide", slug, author: "Studio", body: [] });
  await assert.rejects(() => deleteGuidePermanently(guide.id, "Delete Me Guide"), /Move this guide to Trash/);

  await publishGuide(guide.id);
  const renamed = `trash-guide-del-renamed-${uid()}`;
  await updateGuide(guide.id, { id: guide.id, title: "Delete Me Guide", slug: renamed });
  await archiveGuide(guide.id);
  await trashGuide(guide.id);

  // Old published slug redirects while trashed? No — trashed targets 404.
  assert.equal(await resolveGuideRedirect(slug), null);

  await assert.rejects(() => deleteGuidePermanently(guide.id, "Wrong Title"), /typed title does not match/);
  const snapshot = await deleteGuidePermanently(guide.id, "Delete Me Guide");
  assert.equal(snapshot.slug, renamed);
  assert.ok(snapshot.oldSlugs.includes(slug));

  const db = await getDb();
  assert.equal(await getAdminGuideById(guide.id), null);
  assert.equal(
    (await db.select().from(slugRedirects).where(eq(slugRedirects.entityId, guide.id))).length,
    0
  );
  assert.ok(!(await listTrash()).some((i) => i.id === guide.id));
});

// ---------------------------------------------------------------------------
// 3. Field note lifecycle (incl. revisions)
// ---------------------------------------------------------------------------

test("trash: field note archive restores to draft; permanent delete clears revisions", async () => {
  const slug = `trash-note-${uid()}`;
  const note = await createFieldNote({ title: "Trash Note", slug, author: "Studio", body: [] });
  await publishFieldNote(note.id);
  await archiveFieldNote(note.id);
  const restored = await restoreFieldNoteFromArchive(note.id);
  assert.equal(restored.status, "draft");

  await trashFieldNote(note.id);
  assert.ok(!(await getAllAdminFieldNotes()).some((n) => n.id === note.id));
  assert.ok(!(await getPublishedFieldNotes()).some((n) => n.id === note.id));
  assert.equal(await getPublicFieldNoteBySlug(slug), null);
  const untrashed = await restoreFieldNoteFromTrash(note.id);
  assert.equal(untrashed.status, "draft");

  await trashFieldNote(note.id);
  await deleteFieldNotePermanently(note.id, "Trash Note");
  const db = await getDb();
  assert.equal(await getAdminFieldNoteById(note.id), null);
  assert.equal(
    (await db.select().from(fieldNoteRevisions).where(eq(fieldNoteRevisions.fieldNoteId, note.id))).length,
    0
  );
});

// ---------------------------------------------------------------------------
// 4. Course lifecycle
// ---------------------------------------------------------------------------

test("trash: course archive restores to draft; trash hides from public and learner views", async () => {
  const slug = `trash-course-${uid()}`;
  const course = await createCourse({ title: "Trash Course", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  assert.ok(await getPublishedCourseBySlug(slug));
  await archiveCourse(course.id);
  assert.equal(await getPublishedCourseBySlug(slug), null);

  const restored = await restoreCourseFromArchive(course.id);
  assert.equal(restored.status, "draft");
  const republished = await publishCourse(course.id);
  assert.equal(republished.status, "published");

  await archiveCourse(course.id);
  await trashCourse(course.id);
  assert.ok(!(await getAllAdminCourses()).some((c) => c.id === course.id));
  assert.ok(!(await getPublishedCourses()).some((c) => c.id === course.id));
  assert.equal(await getPublishedCourseBySlug(slug), null);
  assert.equal(await getLearnerCourseBySlug(slug, null), null);
  assert.equal(await resolveCourseRedirect(slug), null);

  const untrashed = await restoreCourseFromTrash(course.id);
  // Course was archived before trashing, so it returns to archived.
  assert.equal(untrashed.status, "archived");
  assert.ok((await getAllAdminCourses()).some((c) => c.id === course.id));
});

test("trash: published course cannot move to Trash; trashed course refuses lifecycle actions", async () => {
  const slug = `trash-course-guard-${uid()}`;
  const course = await createCourse({ title: "Guard Course", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  await assert.rejects(() => trashCourse(course.id), /Unpublish or archive/);
  await archiveCourse(course.id);
  await trashCourse(course.id);
  await assert.rejects(() => publishCourse(course.id), /in Trash/);
  await assert.rejects(() => archiveCourse(course.id), /in Trash/);
  await restoreCourseFromTrash(course.id);
});

test("trash: course permanent delete removes children, offer, redirects and R2 objects", async () => {
  const slug = `trash-course-del-${uid()}`;
  const course = await createCourse({ title: "Delete Me Course", slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const l1 = await createLesson({ courseId: course.id, sectionId: section.id, title: "L1", slug: `l1-${uid()}` });
  const l2 = await createLesson({ courseId: course.id, sectionId: section.id, title: "L2", slug: `l2-${uid()}` });
  await publishLesson(l1.id);
  const offer = await createOffer({ kind: "COURSE", courseId: course.id, title: "Offer", slug: `offer-${uid()}`, accessMode: "FREE" });

  // Ever-published slug redirect: publish, rename, then trash.
  await publishCourse(course.id);
  const renamed = `trash-course-del-renamed-${uid()}`;
  await updateCourse(course.id, { id: course.id, title: "Delete Me Course", slug: renamed });

  // A real R2-backed lesson resource.
  const uploaded = await uploadCourseResource({
    buffer: new TextEncoder().encode("%PDF-1.4 fake resource"),
    filename: "notes.pdf",
    contentType: "application/pdf",
    courseId: course.id,
    lessonId: l1.id,
    title: "Notes",
  });
  const bucket = await getR2Bucket();
  assert.ok(await bucket.get(uploaded.storageKey));

  await archiveCourse(course.id);
  await trashCourse(course.id);
  const snapshot = await deleteCoursePermanently(course.id, "Delete Me Course");
  assert.equal(snapshot.slug, renamed);
  assert.ok(snapshot.oldSlugs.includes(slug));

  const db = await getDb();
  assert.equal(await getAdminCourseById(course.id), null);
  assert.equal((await db.select().from(courseSections).where(eq(courseSections.courseId, course.id))).length, 0);
  assert.equal((await db.select().from(lessons).where(eq(lessons.courseId, course.id))).length, 0);
  assert.equal((await db.select().from(lessonResources).where(eq(lessonResources.courseId, course.id))).length, 0);
  assert.equal((await db.select().from(slugRedirects).where(eq(slugRedirects.entityId, course.id))).length, 0);
  assert.equal((await db.select().from(offers).where(eq(offers.id, offer.id))).length, 0);
  assert.equal(await bucket.get(uploaded.storageKey), null);
  assert.equal(await resolveCourseRedirect(slug), null);
  assert.ok(l1.id && l2.id, "lesson ids collected");
});

// ---------------------------------------------------------------------------
// 5. Course delete protection (enrollment / certificate / order, any status)
// ---------------------------------------------------------------------------

test("trash: course with any enrollment can never be deleted permanently", async () => {
  const learner = await createUser("trash-learner", false);
  const slug = `trash-course-prot-${uid()}`;
  const course = await createCourse({ title: "Protected Course", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const enrollment = await enrollFree(learner.id, course.id);

  await archiveCourse(course.id);
  await trashCourse(course.id);
  await assert.rejects(() => deleteCoursePermanently(course.id, "Protected Course"), /learners are attached/);

  // Cancelling keeps the row — protection holds for any status.
  await cancelMyEnrollment(learner.id, course.id);
  await assert.rejects(() => deleteCoursePermanently(course.id, "Protected Course"), /learners are attached/);
  assert.ok(enrollment.id, "enrollment created");
});

test("trash: course with a certificate or order can never be deleted permanently", async () => {
  const learner = await createUser("trash-learner2", false);
  const slug = `trash-course-prot2-${uid()}`;
  const course = await createCourse({ title: "Protected Course 2", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const enrollment = await enrollFree(learner.id, course.id);
  const db = await getDb();
  await db.insert(certificates).values({
    id: `cert_${uid()}`,
    userId: learner.id,
    courseId: course.id,
    enrollmentId: enrollment.id,
    recipientName: "Learner",
    courseTitle: course.title,
    issuedAt: new Date(),
  });
  const offer = await createOffer({ kind: "COURSE", courseId: course.id, title: "Offer", slug: `offer-${uid()}`, accessMode: "FREE" });
  await db.insert(orders).values({
    id: `order_${uid()}`,
    offerId: offer.id,
    offerKind: "COURSE",
    accessMode: "FREE",
    courseId: course.id,
    userId: learner.id,
    requestKey: `req_${uid()}`,
    customerEmail: learner.email,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await assert.rejects(() => assertCourseDeletable(course.id), /learners are attached/);
  await archiveCourse(course.id);
  await trashCourse(course.id);
  await assert.rejects(() => deleteCoursePermanently(course.id, "Protected Course 2"), /learners are attached/);

  // And the Trash page flags it as protected.
  const items = await listTrash();
  const row = items.find((i) => i.id === course.id);
  assert.ok(row, "protected course listed in Trash");
  assert.equal(row.protected, true);
  assert.match(row.protectionReason ?? "", /learners are attached/);
});

// ---------------------------------------------------------------------------
// 6. Lesson lifecycle + protection
// ---------------------------------------------------------------------------

test("trash: lesson archive restores to draft; trash hides it from the curriculum", async () => {
  const slug = `trash-lesson-course-${uid()}`;
  const course = await createCourse({ title: "Lesson Trash Course", slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const lesson = await createLesson({ courseId: course.id, sectionId: section.id, title: "Trash Lesson", slug: `tl-${uid()}` });
  await publishLesson(lesson.id);
  assert.ok((await getCourseCurriculum(course.id)).flatMap((c) => c.publishedLessons).some((l) => l.id === lesson.id));

  await archiveLesson(lesson.id);
  assert.equal(await getPublishedLessonBySlug(course.id, lesson.slug), null);
  const restored = await restoreLessonFromArchive(lesson.id);
  assert.equal(restored.status, "draft");

  await trashLesson(lesson.id);
  const curriculum = await getCourseCurriculum(course.id);
  assert.ok(!curriculum.flatMap((c) => c.lessons).some((l) => l.id === lesson.id));
  const untrashed = await restoreLessonFromTrash(lesson.id);
  assert.equal(untrashed.status, "draft");
  assert.ok((await getCourseCurriculum(course.id)).flatMap((c) => c.lessons).some((l) => l.id === lesson.id));
});

test("trash: lesson with any learner data can never be deleted permanently", async () => {
  const learner = await createUser("trash-learner3", false);
  const slug = `trash-lesson-prot-${uid()}`;
  const course = await createCourse({ title: "Lesson Prot Course", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const enrollment = await enrollFree(learner.id, course.id);
  const section = await createSection({ courseId: course.id, title: "S1" });
  const db = await getDb();

  async function trashedLessonWith(title: string) {
    const lesson = await createLesson({ courseId: course.id, sectionId: section.id, title, slug: `${title.toLowerCase().replaceAll(" ", "-")}-${uid()}` });
    await trashLesson(lesson.id);
    return lesson;
  }

  // Progress blocks.
  const withProgress = await trashedLessonWith("Progress Lesson");
  await db.insert(lessonProgress).values({ id: `lp_${uid()}`, enrollmentId: enrollment.id, lessonId: withProgress.id, completedAt: new Date() });
  await assert.rejects(() => deleteLessonPermanently(withProgress.id, "Progress Lesson"), /interacted with it/);

  // Quiz attempt blocks.
  const withAttempt = await trashedLessonWith("Attempt Lesson");
  const quizId = `quiz_${uid()}`;
  await db.insert(lessonQuizzes).values({ id: quizId, courseId: course.id, lessonId: withAttempt.id, questions: "[]", createdAt: new Date(), updatedAt: new Date() });
  await db.insert(quizAttempts).values({
    id: `qa_${uid()}`, quizId, userId: learner.id, enrollmentId: enrollment.id, lessonId: withAttempt.id,
    answers: "{}", scorePercent: 0, correctCount: 0, totalCount: 1, passed: false, createdAt: new Date(),
  });
  await assert.rejects(() => deleteLessonPermanently(withAttempt.id, "Attempt Lesson"), /interacted with it/);

  // Private note blocks.
  const withNote = await trashedLessonWith("Note Lesson");
  await db.insert(lessonNotes).values({
    id: `ln_${uid()}`, userId: learner.id, courseId: course.id, lessonId: withNote.id,
    body: "private", createdAt: new Date(), updatedAt: new Date(),
  });
  await assert.rejects(() => deleteLessonPermanently(withNote.id, "Note Lesson"), /interacted with it/);

  // Question blocks.
  const withQuestion = await trashedLessonWith("Question Lesson");
  await db.insert(lessonQuestions).values({
    id: `lq_${uid()}`, lessonId: withQuestion.id, courseId: course.id, userId: learner.id,
    body: "a question", idempotencyKey: `q_${uid()}`, createdAt: new Date(), updatedAt: new Date(),
  });
  await assert.rejects(() => deleteLessonPermanently(withQuestion.id, "Question Lesson"), /interacted with it/);

  // A clean trashed lesson deletes fine, with its quiz and redirects gone.
  const clean = await trashedLessonWith("Clean Lesson");
  const cleanQuizId = `quiz_${uid()}`;
  await db.insert(lessonQuizzes).values({ id: cleanQuizId, courseId: course.id, lessonId: clean.id, questions: "[]", createdAt: new Date(), updatedAt: new Date() });
  await deleteLessonPermanently(clean.id, "Clean Lesson");
  assert.equal(await getAdminLessonById(clean.id), null);
  assert.equal((await db.select().from(lessonQuizzes).where(eq(lessonQuizzes.lessonId, clean.id))).length, 0);
  assert.equal(
    await assertLessonDeletable(withProgress.id).then(() => "deletable", () => "protected"),
    "protected"
  );
});

// ---------------------------------------------------------------------------
// 7. Trash listing + purge
// ---------------------------------------------------------------------------

test("trash: Trash page lists every type with days left; registry rejects unknown types", async () => {
  assert.equal(getTrashableType("page"), null);
  const guide = await createGuide({ title: "List Guide", slug: `list-guide-${uid()}`, author: "Studio", body: [] });
  await trashGuide(guide.id);
  const note = await createFieldNote({ title: "List Note", slug: `list-note-${uid()}`, author: "Studio", body: [] });
  await trashFieldNote(note.id);

  const items = await listTrash();
  const guideRow = items.find((i) => i.id === guide.id);
  const noteRow = items.find((i) => i.id === note.id);
  assert.ok(guideRow && noteRow);
  assert.equal(guideRow.type, "guide");
  assert.equal(noteRow.type, "field_note");
  assert.equal(guideRow.daysLeft, 30);
  assert.equal(guideRow.expired, false);
  assert.equal(guideRow.protected, false);
});

test("trash: purge deletes only items past 30 days and skips protected ones", async () => {
  const fresh = await createGuide({ title: "Fresh Guide", slug: `fresh-${uid()}`, author: "Studio", body: [] });
  await trashGuide(fresh.id);
  const stale = await createGuide({ title: "Stale Guide", slug: `stale-${uid()}`, author: "Studio", body: [] });
  await trashGuide(stale.id);

  // Backdate the stale row past the retention window.
  const db = await getDb();
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  await db.update(guides).set({ trashedAt: old }).where(eq(guides.id, stale.id));

  const purged = await purgeExpiredTrash(new Date(), 5);
  assert.ok(purged >= 1, "at least the stale guide is purged");
  assert.equal(await getAdminGuideById(stale.id), null);
  assert.ok(await getAdminGuideById(fresh.id), "fresh item stays in Trash");

  // A stale but protected course stays and stays flagged.
  const learner = await createUser("trash-learner4", false);
  const cslug = `stale-prot-course-${uid()}`;
  const course = await createCourse({ title: "Stale Protected", slug: cslug, accessMode: "FREE" });
  await publishCourse(course.id);
  await enrollFree(learner.id, course.id);
  await archiveCourse(course.id);
  await trashCourse(course.id);
  await db.update(courses).set({ trashedAt: old }).where(eq(courses.id, course.id));
  const before = await purgeExpiredTrash(new Date(), 5);
  assert.ok((await getAdminCourseById(course.id)) !== null, "protected course is never purged");
  const flagged = (await listTrash()).find((i) => i.id === course.id);
  assert.ok(flagged?.protected, "protected item stays flagged in Trash");
  assert.ok(before >= 0);
});

// ---------------------------------------------------------------------------
// 8. Sitemap hides trashed content
// ---------------------------------------------------------------------------

test("trash: sitemap drops trashed guides and field notes", async () => {
  const gslug = `sitemap-guide-${uid()}`;
  const guide = await createGuide({ title: "Sitemap Guide", slug: gslug, author: "Studio", body: [] });
  await publishGuide(guide.id);
  let entries = await buildSitemapEntries();
  assert.ok(entries.some((e) => e.url.endsWith(`/guides/${gslug}`)));
  await archiveGuide(guide.id);
  await trashGuide(guide.id);
  entries = await buildSitemapEntries();
  assert.ok(!entries.some((e) => e.url.endsWith(`/guides/${gslug}`)), "trashed guide leaves the sitemap");

  const nslug = `sitemap-note-${uid()}`;
  const note = await createFieldNote({ title: "Sitemap Note", slug: nslug, author: "Studio", body: [] });
  await publishFieldNote(note.id);
  entries = await buildSitemapEntries();
  assert.ok(entries.some((e) => e.url.endsWith(`/field-notes/${nslug}`)));
  await archiveFieldNote(note.id);
  await trashFieldNote(note.id);
  entries = await buildSitemapEntries();
  assert.ok(!entries.some((e) => e.url.endsWith(`/field-notes/${nslug}`)), "trashed note leaves the sitemap");
});

// ---------------------------------------------------------------------------
// 9. Server-action authorization + validation + audit
// ---------------------------------------------------------------------------

test("trash: actions reject signed-out callers without touching data", async () => {
  cookieHeader = "";
  for (const run of [
    () => trashActions.trashItemAction({ type: "guide", id: "x" }),
    () => trashActions.restoreArchivedItemAction({ type: "guide", id: "x" }),
    () => trashActions.restoreTrashedItemAction({ type: "guide", id: "x" }),
    () => trashActions.deletePermanentlyAction({ type: "guide", id: "x", confirmTitle: "x" }),
  ]) {
    const res = await run();
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /Unauthorized/);
  }
});

test("trash: actions reject learners and validate input as admin", async () => {
  const learner = await createUser("trash-learner5", false);
  cookieHeader = await signInCookie(learner.email, learner.password);

  const forbidden = await trashActions.trashItemAction({ type: "guide", id: "nope" });
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.ok ? "" : forbidden.error, /Admin access required/);

  // Back to admin for validation checks.
  cookieHeader = await signInCookie(adminEmail, ADMIN_PASSWORD);

  const badType = await trashActions.trashItemAction({ type: "page", id: "x" });
  assert.equal(badType.ok, false);

  const missing = await trashActions.restoreTrashedItemAction({ type: "guide", id: "does-not-exist" });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /not found/i);
});

test("trash: admin trash action audits, revalidates and restores", async () => {
  const db = await getDb();
  // Re-sign in as admin (previous test left a learner cookie).
  cookieHeader = await signInCookie(adminEmail, ADMIN_PASSWORD);
  revalidatedPaths.length = 0;

  const slug = `action-guide-${uid()}`;
  const guide = await createGuide({ title: "Action Guide", slug, author: "Studio", body: [] });
  await archiveGuide(guide.id);

  const trashed = await trashActions.trashItemAction({ type: "guide", id: guide.id });
  assert.equal(trashed.ok, true);
  assert.ok(revalidatedPaths.includes("/admin/trash"));
  assert.ok(revalidatedPaths.includes("/guides"));
  const trashAudit = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityId, guide.id), eq(adminAuditLog.action, "guide.trash")))
    .get();
  assert.ok(trashAudit, "trash writes an audit row");
  assert.equal(trashAudit.actorId, adminId);

  const restored = await trashActions.restoreTrashedItemAction({ type: "guide", id: guide.id });
  assert.equal(restored.ok, true);
  // The guide was archived when trashed, so restore returns it to archived.
  assert.equal((await getAdminGuideById(guide.id))?.status, "archived");
  const untrashAudit = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.entityId, guide.id), eq(adminAuditLog.action, "guide.untrash")))
    .get();
  assert.ok(untrashAudit, "restore-from-trash writes an audit row");

  const restoredArchive = await trashActions.restoreArchivedItemAction({ type: "guide", id: guide.id });
  assert.equal(restoredArchive.ok, true);
  assert.equal((await getAdminGuideById(guide.id))?.status, "draft");

  const restoreDraft = await trashActions.restoreArchivedItemAction({ type: "guide", id: guide.id });
  assert.equal(restoreDraft.ok, false, "a draft guide cannot restore-from-archive");
});
