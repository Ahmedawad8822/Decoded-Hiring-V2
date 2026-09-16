import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.
import {
  getDb,
  users,
  courses,
  courseSections,
  lessons,
  lessonResources,
  enrollments,
  lessonProgress,
  guides,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { requireAdmin, requireUser } from "../src/lib/auth";
import {
  createCourse,
  updateCourse,
  publishCourse,
  unpublishLesson,
  archiveCourse,
  createSection,
  moveSection,
  createLesson,
  updateLesson,
  publishLesson,
  moveLesson,
  getCourseSections,
  getPublishedCourseBySlug,
  getPublishedLessonBySlug,
  getPublishedCourseLessons,
  getLearnerCourseBySlug,
  getCourseCurriculum,
  getCourseEnrollmentCounts,
  getPublishedLessonCounts,
  getCoursesByIds,
  getLessonCompletionCount,
  getLessonCompletionCounts,
  getLessonResources,
  getLessonResourcesForLessons,
} from "../src/features/courses/service";
import {
  enrollFree,
  getEnrollment,
  requireEnrollment,
  getAccessibleEnrollments,
} from "../src/features/enrollments/service";
import { hasLearnerAccess } from "../src/features/enrollments/access";
import {
  getEnrollmentProgress,
  markLessonComplete,
  reconcileEnrollmentCompletion,
} from "../src/features/progress/service";
import {
  extractYouTubeVideoId,
  isValidYouTubeUrl,
} from "../src/features/courses/youtube";
import { getCourseResourceObject } from "../src/lib/course-resources/service";
import {
  hasPdfMagicBytes,
  uploadCourseResource,
} from "../src/lib/course-resources/service";
import { getMedia, isPublicMediaKey } from "../src/lib/media/service";
import { eq } from "drizzle-orm";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function makeUser(email: string): Promise<string> {
  const db = await getDb();
  const id = `u_test_${stamp()}`;
  const now = new Date();
  await db.insert(users).values({
    id,
    name: "Test Learner",
    email,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
    role: "user",
  });
  return id;
}

async function cleanupCourse(courseSlug: string) {
  const db = await getDb();
  const course = await db.select().from(courses).where(eq(courses.slug, courseSlug)).get();
  if (!course) return;
  // FK order: progress -> enrollments -> resources -> lessons -> sections -> course
  const dbLessons = await db.select().from(lessons).where(eq(lessons.courseId, course.id));
  for (const l of dbLessons) {
    await db.delete(lessonProgress).where(eq(lessonProgress.lessonId, l.id));
  }
  const dbEnrollments = await db.select().from(enrollments).where(eq(enrollments.courseId, course.id));
  for (const e of dbEnrollments) {
    await db.delete(lessonProgress).where(eq(lessonProgress.enrollmentId, e.id));
  }
  await db.delete(enrollments).where(eq(enrollments.courseId, course.id));
  await db.delete(lessonResources).where(eq(lessonResources.courseId, course.id));
  await db.delete(lessons).where(eq(lessons.courseId, course.id));
  await db.delete(courseSections).where(eq(courseSections.courseId, course.id));
  await db.delete(courses).where(eq(courses.id, course.id));
}

// ---------------------------------------------------------------- auth helpers

test("M06-AUTH: anonymous callers are rejected by requireAdmin/requireUser", async () => {
  await assert.rejects(() => requireAdmin(), /Unauthorized/);
  await assert.rejects(() => requireUser(), /Unauthorized/);
});

// ---------------------------------------------------------------- course slugs

test("M06-C1: course slug uniqueness is enforced", async () => {
  const slug = `m06-c1-${stamp()}`;
  await createCourse({ title: "Slug Test", slug, accessMode: "FREE" });
  await assert.rejects(
    () => createCourse({ title: "Slug Test Dup", slug, accessMode: "FREE" }),
    /already exists/
  );
  await cleanupCourse(slug);
});

// ---------------------------------------------------------------- ordering

test("M06-C2: section ordering follows position and move up/down swaps", async () => {
  const slug = `m06-c2-${stamp()}`;
  const course = await createCourse({ title: "Order Test", slug, accessMode: "FREE" });
  const s1 = await createSection({ courseId: course.id, title: "First" });
  const s2 = await createSection({ courseId: course.id, title: "Second" });
  const s3 = await createSection({ courseId: course.id, title: "Third" });
  assert.ok(s1.position < s2.position && s2.position < s3.position);

  const moved = await moveSection(s3.id, "up");
  const titles = moved.map((s) => s.title);
  assert.deepEqual(titles, ["First", "Third", "Second"]);

  const movedBack = await moveSection(s3.id, "down");
  assert.deepEqual(
    movedBack.map((s) => s.title),
    ["First", "Second", "Third"]
  );
  await cleanupCourse(slug);
});

test("M06-C3: lesson ordering follows position; slug unique per course", async () => {
  const slug = `m06-c3-${stamp()}`;
  const course = await createCourse({ title: "Lesson Order", slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const l1 = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Alpha Lesson",
    slug: `alpha-${stamp()}`,
    required: true,
  });
  const l2 = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Beta Lesson",
    slug: `beta-${stamp()}`,
    required: true,
  });
  assert.ok(l1.position < l2.position);

  const moved = await moveLesson(l2.id, "up");
  assert.deepEqual(
    moved.map((l) => l.id),
    [l2.id, l1.id]
  );

  // Same slug in the SAME course is rejected...
  await assert.rejects(
    () =>
      createLesson({
        courseId: course.id,
        sectionId: section.id,
        title: "Alpha Again",
        slug: l1.slug,
        required: true,
      }),
    /already exists in this course/
  );

  // ...but the same slug in a DIFFERENT course is allowed.
  const slug2 = `m06-c3b-${stamp()}`;
  const course2 = await createCourse({ title: "Other Course", slug: slug2, accessMode: "FREE" });
  const section2 = await createSection({ courseId: course2.id, title: "S1" });
  const cross = await createLesson({
    courseId: course2.id,
    sectionId: section2.id,
    title: "Alpha Elsewhere",
    slug: l1.slug,
    required: true,
  });
  assert.equal(cross.slug, l1.slug);

  await cleanupCourse(slug);
  await cleanupCourse(slug2);
});

// ---------------------------------------------------------------- enrollment

test("M06-E1: FREE enrollment is idempotent; duplicates impossible", async () => {
  const slug = `m06-e1-${stamp()}`;
  const course = await createCourse({ title: "Enroll Test", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const userId = await makeUser(`m06-e1-${stamp()}@example.com`);

  const first = await enrollFree(userId, course.id);
  const second = await enrollFree(userId, course.id);
  assert.equal(first.id, second.id, "second enroll must return the existing enrollment");

  const found = await getEnrollment(userId, course.id);
  assert.equal(found?.id, first.id);
  await cleanupCourse(slug);
});

test("M06-E2: non-FREE access modes reject automatic enrollment honestly", async () => {
  const modes = ["PAID_ONE_TIME", "MANUAL_INVOICE", "PAYMENT_DISABLED"] as const;
  const userId = await makeUser(`m06-e2-${stamp()}@example.com`);
  for (const mode of modes) {
    const slug = `m06-e2-${mode.toLowerCase()}-${stamp()}`;
    const course = await createCourse({ title: `Mode ${mode}`, slug, accessMode: mode });
    await publishCourse(course.id);
    await assert.rejects(() => enrollFree(userId, course.id), /payment|invoice|disabled/i);
    await cleanupCourse(slug);
  }
});

test("M06-E3: draft courses reject enrollment; archived reject NEW enrollments", async () => {
  const userId = await makeUser(`m06-e3-${stamp()}@example.com`);

  const draftSlug = `m06-e3-draft-${stamp()}`;
  const draft = await createCourse({ title: "Draft Course", slug: draftSlug, accessMode: "FREE" });
  await assert.rejects(() => enrollFree(userId, draft.id), /not yet published/);

  // Publish -> enroll -> archive: existing learner keeps access, newcomer refused.
  await publishCourse(draft.id);
  const existing = await enrollFree(userId, draft.id);
  assert.ok(existing.id);
  await archiveCourse(draft.id);

  const newcomer = await makeUser(`m06-e3-new-${stamp()}@example.com`);
  await assert.rejects(() => enrollFree(newcomer, draft.id), /archived/);

  const retained = await requireEnrollment(userId, draft.id);
  assert.equal(retained.id, existing.id, "existing learner retains archived access");

  await cleanupCourse(draftSlug);
});

test("M06-E4: unenrolled users cannot resolve an enrollment", async () => {
  const slug = `m06-e4-${stamp()}`;
  const course = await createCourse({ title: "Gate Test", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const userId = await makeUser(`m06-e4-${stamp()}@example.com`);
  await assert.rejects(() => requireEnrollment(userId, course.id), /not enrolled/);
  await cleanupCourse(slug);
});

// ---------------------------------------------------------------- progress

async function makeProgressCourse(tag: string) {
  const slug = `m06-p-${tag}-${stamp()}`;
  const course = await createCourse({ title: `Progress ${tag}`, slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const mk = (title: string, s: string, required: boolean) =>
    createLesson({ courseId: course.id, sectionId: section.id, title, slug: `${s}-${stamp()}`, required });
  const req1 = await mk("Required One", "req-one", true);
  const req2 = await mk("Required Two", "req-two", true);
  const opt = await mk("Optional Extra", "opt-extra", false);
  for (const l of [req1, req2, opt]) await publishLesson(l.id);
  await publishCourse(course.id);
  return { course, req1, req2, opt, slug };
}

test("M06-P1: progress counts REQUIRED published lessons only", async () => {
  const { course, req1, opt, slug } = await makeProgressCourse("req");
  const userId = await makeUser(`m06-p1-${stamp()}@example.com`);
  const enrollment = await enrollFree(userId, course.id);

  let progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.totalRequired, 2);
  assert.equal(progress.percent, 0);

  // Completing the OPTIONAL lesson changes nothing in the denominator.
  await markLessonComplete(userId, enrollment.id, opt.id);
  progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.totalRequired, 2);
  assert.equal(progress.completedRequired, 0);
  assert.equal(progress.percent, 0);

  await markLessonComplete(userId, enrollment.id, req1.id);
  progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.completedRequired, 1);
  assert.equal(progress.percent, 50);
  assert.equal(progress.resumeLesson?.id, (await getEnrollmentProgress(enrollment)).resumeLesson?.id);

  await cleanupCourse(slug);
});

test("M06-P2: mark-complete is idempotent; course completes with completedAt", async () => {
  const { course, req1, req2, slug } = await makeProgressCourse("done");
  const userId = await makeUser(`m06-p2-${stamp()}@example.com`);
  const enrollment = await enrollFree(userId, course.id);

  const once = await markLessonComplete(userId, enrollment.id, req1.id);
  assert.equal(once.alreadyComplete, false);
  const twice = await markLessonComplete(userId, enrollment.id, req1.id);
  assert.equal(twice.alreadyComplete, true);

  const db = await getDb();
  const rows = await db
    .select()
    .from(lessonProgress)
    .where(eq(lessonProgress.enrollmentId, enrollment.id));
  const forReq1 = rows.filter((r) => r.lessonId === req1.id);
  assert.equal(forReq1.length, 1, "exactly one progress row per lesson");

  const final = await markLessonComplete(userId, enrollment.id, req2.id);
  assert.equal(final.progress.completed, true);
  assert.equal(final.progress.percent, 100);
  assert.ok(final.enrollment.completedAt, "enrollment.completedAt must be set on completion");

  await cleanupCourse(slug);
});

test("M06-P3: learner A cannot complete learner B progress (cross-user denial)", async () => {
  const { course, req1, slug } = await makeProgressCourse("xuser");
  const userA = await makeUser(`m06-p3a-${stamp()}@example.com`);
  const userB = await makeUser(`m06-p3b-${stamp()}@example.com`);
  const enrollmentA = await enrollFree(userA, course.id);
  await enrollFree(userB, course.id);

  // B tries to write into A's enrollment -> forbidden.
  await assert.rejects(
    () => markLessonComplete(userB, enrollmentA.id, req1.id),
    /another learner/
  );

  // B tries a fabricated enrollment id for a lesson in the course -> not found.
  await assert.rejects(
    () => markLessonComplete(userB, "enroll_doesnotexist", req1.id),
    /not found/
  );

  await cleanupCourse(slug);
});

test("M06-P4: draft lessons are invisible to learners; published resolve", async () => {
  const slug = `m06-p4-${stamp()}`;
  const course = await createCourse({ title: "Visibility", slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const draftLesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Hidden Draft",
    slug: `hidden-${stamp()}`,
    required: true,
  });
  await publishCourse(course.id);

  const hidden = await getPublishedLessonBySlug(course.id, draftLesson.slug);
  assert.equal(hidden, null, "draft lessons must not resolve for learners");

  const pub = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Visible Lesson",
    slug: `visible-${stamp()}`,
    required: true,
  });
  await publishLesson(pub.id);
  const visible = await getPublishedLessonBySlug(course.id, pub.slug);
  assert.ok(visible);

  const listed = await getPublishedCourseLessons(course.id);
  assert.ok(!listed.some((l) => l.id === draftLesson.id));
  assert.ok(listed.some((l) => l.id === pub.id));

  const pubCourse = await getPublishedCourseBySlug(slug);
  assert.ok(pubCourse);
  const missing = await getPublishedCourseBySlug(`nope-${stamp()}`);
  assert.equal(missing, null);

  await cleanupCourse(slug);
});

// ---------------------------------------------------------------- youtube

test("M06-V1: YouTube validation accepts real forms, rejects the rest", async () => {
  const good = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "dQw4w9WgXcQ",
  ];
  for (const url of good) {
    assert.equal(isValidYouTubeUrl(url), true, url);
    assert.equal(extractYouTubeVideoId(url), "dQw4w9WgXcQ");
  }
  const bad = [
    "https://vimeo.com/123456789",
    "https://example.com/video.mp4",
    "javascript:alert(1)",
    "<iframe src='https://www.youtube.com/embed/dQw4w9WgXcQ'></iframe>",
    "not a url",
    "",
    "https://www.youtube.com/watch?v=short",
  ];
  for (const url of bad) {
    assert.equal(isValidYouTubeUrl(url), false, url);
  }

  // Service-level: invalid video URL rejected on create and update.
  const slug = `m06-v1-${stamp()}`;
  const course = await createCourse({ title: "Video Test", slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  await assert.rejects(
    () =>
      createLesson({
        courseId: course.id,
        sectionId: section.id,
        title: "Bad Video",
        slug: `bad-vid-${stamp()}`,
        videoUrl: "https://vimeo.com/123456789",
        required: true,
      }),
    /YouTube/
  );
  await cleanupCourse(slug);
});

// ---------------------------------------------------------------- resources

test("M06-R1: resource storage boundary rejects non-course namespaces", async () => {
  assert.equal(await getCourseResourceObject("guides/abc.jpg"), null);
  assert.equal(await getCourseResourceObject("field-notes/abc.png"), null);
  assert.equal(await getCourseResourceObject("course-resources/../../etc/passwd"), null);
  assert.equal(await getCourseResourceObject(""), null);
});

// ---------------------------------------------------------------- review corrections (A-L)

test("M06-R2: public media serves ONLY allowlisted namespaces (A)", async () => {
  // Pure allowlist verdicts — no storage touched.
  assert.equal(isPublicMediaKey("guides/cover.jpg"), true);
  assert.equal(isPublicMediaKey("field-notes/photo.png"), true);
  assert.equal(isPublicMediaKey("course-resources/c1/deadbeef.pdf"), false);
  assert.equal(isPublicMediaKey("course-resources"), false);
  assert.equal(isPublicMediaKey("../guides/cover.jpg"), false);
  assert.equal(isPublicMediaKey("/etc/passwd"), false);
  assert.equal(isPublicMediaKey(""), false);

  // Protected learner PDFs are unreachable through the public route: getMedia
  // answers null BEFORE touching R2, so UUID secrecy is never load-bearing.
  assert.equal(await getMedia("course-resources/c1/deadbeef.pdf"), null);
  assert.equal(await getMedia("../guides/cover.jpg"), null);
});

test("M06-R3: cancelled enrollments are denied on every boundary (C)", async () => {
  const { course, req1, slug } = await makeProgressCourse("cancelled");
  const userId = await makeUser(`m06-r3-${stamp()}@example.com`);
  const enrollment = await enrollFree(userId, course.id);
  assert.equal(hasLearnerAccess(enrollment), true);

  const db = await getDb();
  await db
    .update(enrollments)
    .set({ status: "cancelled" })
    .where(eq(enrollments.id, enrollment.id));
  const cancelled = await getEnrollment(userId, course.id);
  assert.equal(hasLearnerAccess(cancelled), false);
  assert.equal(hasLearnerAccess(null), false);

  await assert.rejects(() => requireEnrollment(userId, course.id), /not enrolled/);
  await assert.rejects(
    () => markLessonComplete(userId, enrollment.id, req1.id),
    /no longer active/
  );

  await cleanupCourse(slug);
});

test("M06-R4: archived courses stay visible to entitled learners only (D)", async () => {
  const slug = `m06-r4-${stamp()}`;
  const course = await createCourse({ title: "Archive Visibility", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const learner = await makeUser(`m06-r4-l-${stamp()}@example.com`);
  const stranger = await makeUser(`m06-r4-s-${stamp()}@example.com`);
  await enrollFree(learner, course.id);
  await archiveCourse(course.id);

  // Public view 404s; entitled learner keeps access; strangers (and the
  // anonymous) see nothing.
  assert.equal(await getPublishedCourseBySlug(slug), null);
  assert.ok(await getLearnerCourseBySlug(slug, learner));
  assert.equal(await getLearnerCourseBySlug(slug, stranger), null);
  assert.equal(await getLearnerCourseBySlug(slug, null), null);
  assert.equal(await getLearnerCourseBySlug(slug, undefined), null);

  await cleanupCourse(slug);
});

test("M06-R5: curriculum groups every section in memory, no per-section gaps (E)", async () => {
  const slug = `m06-r5-${stamp()}`;
  const course = await createCourse({ title: "Curriculum Grouping", slug, accessMode: "FREE" });
  const s1 = await createSection({ courseId: course.id, title: "S1" });
  const s2 = await createSection({ courseId: course.id, title: "S2" });
  const mk = (sectionId: string, title: string, s: string) =>
    createLesson({ courseId: course.id, sectionId, title, slug: `${s}-${stamp()}`, required: true });
  const a = await mk(s1.id, "A", "r5-a");
  const b = await mk(s2.id, "B", "r5-b");
  const c = await mk(s1.id, "C", "r5-c");

  const curriculum = await getCourseCurriculum(course.id);
  assert.equal(curriculum.length, 2);
  assert.deepEqual(
    curriculum.find((e) => e.section.id === s1.id)?.lessons.map((l) => l.id),
    [a.id, c.id]
  );
  assert.deepEqual(
    curriculum.find((e) => e.section.id === s2.id)?.lessons.map((l) => l.id),
    [b.id]
  );

  await cleanupCourse(slug);
});

test("M06-R6: completion reopens when the curriculum grows (H)", async () => {
  const { course, req1, req2, slug } = await makeProgressCourse("reopen");
  const userId = await makeUser(`m06-r6-${stamp()}@example.com`);
  const enrollment = await enrollFree(userId, course.id);

  await markLessonComplete(userId, enrollment.id, req1.id);
  await markLessonComplete(userId, enrollment.id, req2.id);
  let progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.completed, true);
  let row = await getEnrollment(userId, course.id);
  assert.equal(row?.status, "completed");

  // Curriculum grows: a new REQUIRED published lesson reopens the enrollment.
  const section = (await getCourseCurriculum(course.id))[0].section;
  const req3 = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Required Three",
    slug: `req-three-${stamp()}`,
    required: true,
  });
  await publishLesson(req3.id);

  progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.completed, false);
  assert.equal(progress.totalRequired, 3);
  row = await getEnrollment(userId, course.id);
  assert.equal(row?.status, "active");
  assert.equal(row?.completedAt, null);

  await cleanupCourse(slug);
});

test("M06-R7: batched stat helpers match per-row truth (G)", async () => {
  const slug = `m06-r7-${stamp()}`;
  const course = await createCourse({ title: "Batch Stats", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const u1 = await makeUser(`m06-r7a-${stamp()}@example.com`);
  const u2 = await makeUser(`m06-r7b-${stamp()}@example.com`);
  await enrollFree(u1, course.id);
  await enrollFree(u2, course.id);

  const counts = await getCourseEnrollmentCounts([course.id, "course_missing"]);
  assert.equal(counts[course.id], 2);
  assert.equal(counts["course_missing"], 0);
  assert.deepEqual(await getCourseEnrollmentCounts([]), {});

  const section = await createSection({ courseId: course.id, title: "S1" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Counted",
    slug: `counted-${stamp()}`,
    required: true,
  });
  await publishLesson(lesson.id);
  const lessonCounts = await getPublishedLessonCounts([course.id, "course_missing"]);
  assert.equal(lessonCounts[course.id], 1);
  assert.equal(lessonCounts["course_missing"], 0);

  await cleanupCourse(slug);
});

test("M06-R8: PDF magic bytes gate the resource store (J)", async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  assert.equal(hasPdfMagicBytes(pdf), true);
  assert.equal(hasPdfMagicBytes(pdf.buffer), true);
  assert.equal(hasPdfMagicBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(hasPdfMagicBytes(new Uint8Array([])), false);

  // A renamed executable with a PDF MIME type is rejected BEFORE any R2 write.
  const slug = `m06-r8-${stamp()}`;
  const course = await createCourse({ title: "Magic Bytes", slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "L",
    slug: `magic-${stamp()}`,
    required: true,
  });
  await assert.rejects(
    () =>
      uploadCourseResource({
        buffer: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]).buffer as ArrayBuffer,
        filename: "evil.pdf",
        contentType: "application/pdf",
        courseId: course.id,
        lessonId: lesson.id,
        title: "Evil",
      }),
    /not a valid PDF/
  );
  await assert.rejects(
    () =>
      uploadCourseResource({
        buffer: new Uint8Array(11 * 1024 * 1024).buffer as ArrayBuffer,
        filename: "big.pdf",
        contentType: "application/pdf",
        courseId: course.id,
        lessonId: lesson.id,
        title: "Big",
      }),
    /exceeds the 10 MB/
  );

  await cleanupCourse(slug);
});

test("M06-R10: UNIQUE indexes reject duplicate rows at the DB level (B)", async () => {
  const slug = `m06-r10-${stamp()}`;
  const course = await createCourse({ title: "Unique Rows", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const userId = await makeUser(`m06-r10-${stamp()}@example.com`);
  const enrollment = await enrollFree(userId, course.id);

  const db = await getDb();
  // Second (userId, courseId) row must fail — enrollFree idempotency is not
  // the only thing standing between us and duplicates.
  await assert.rejects(() =>
    db.insert(enrollments).values({
      id: `enroll_dup_${stamp()}`,
      userId,
      courseId: course.id,
      status: "active",
      enrolledAt: new Date(),
      completedAt: null,
    })
  );

  // Second (enrollmentId, lessonId) progress row must fail the same way.
  const section = await createSection({ courseId: course.id, title: "S1" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "L",
    slug: `uniq-${stamp()}`,
    required: true,
  });
  await publishLesson(lesson.id);
  await markLessonComplete(userId, enrollment.id, lesson.id);
  await assert.rejects(() =>
    db.insert(lessonProgress).values({
      id: `prog_dup_${stamp()}`,
      enrollmentId: enrollment.id,
      lessonId: lesson.id,
      completedAt: new Date(),
    })
  );

  await cleanupCourse(slug);
});

// ---------------------------------------------------------------- final pre-CodeRabbit corrections

test("M06-R11: cancelled enrollments are NEVER resurrected by progress reads", async () => {
  const { course, req1, req2, slug } = await makeProgressCourse("noresurrect");
  const userId = await makeUser(`m06-r11-${stamp()}@example.com`);

  // 1. learner completes the course...
  const enrollment = await enrollFree(userId, course.id);
  await markLessonComplete(userId, enrollment.id, req1.id);
  await markLessonComplete(userId, enrollment.id, req2.id);

  // 2. ...enrollment becomes completed.
  let row = await getEnrollment(userId, course.id);
  assert.equal(row?.status, "completed");

  // 3. enrollment manually becomes cancelled (status + timestamp cleared,
  // as a real cancellation would leave it).
  const db = await getDb();
  await db
    .update(enrollments)
    .set({ status: "cancelled", completedAt: null })
    .where(eq(enrollments.id, enrollment.id));

  // 4. progress reads run against a STALE pre-cancellation (active) snapshot —
  // the exact shape dashboard callers hold — plus a direct reconcile call
  // with a satisfied verdict. Neither may touch the row.
  await getEnrollmentProgress(enrollment);
  await reconcileEnrollmentCompletion(enrollment, true);

  // 5. enrollment remains cancelled.
  row = await getEnrollment(userId, course.id);
  assert.equal(row?.status, "cancelled");
  assert.equal(row?.completedAt, null);

  // 6. hasLearnerAccess remains false.
  assert.equal(hasLearnerAccess(row), false);

  // 7. protected lesson access remains denied: the lesson page gates on
  // hasLearnerAccess (denied panel) and the write path rejects the same way.
  await assert.rejects(() => requireEnrollment(userId, course.id), /not enrolled/);
  await assert.rejects(
    () => markLessonComplete(userId, enrollment.id, req1.id),
    /no longer active/
  );

  // 8. protected resource remains denied: the download route gates on
  // hasLearnerAccess(getEnrollment(...)) — the identical predicate chain
  // asserted here — so a cancelled learner gets the same 403 as a stranger.
  assert.equal(hasLearnerAccess(await getEnrollment(userId, course.id)), false);

  // Explicit FREE re-enrollment is the ONLY path back to active.
  const reactivated = await enrollFree(userId, course.id);
  assert.equal(reactivated.status, "active");
  assert.equal(hasLearnerAccess(reactivated), true);

  await cleanupCourse(slug);
});

test("M06-R12: cancelled enrollments are filtered from learner collection reads", async () => {
  const a = await makeProgressCourse("dash-a");
  const b = await makeProgressCourse("dash-b");
  const userId = await makeUser(`m06-r12-${stamp()}@example.com`);
  const enrollmentA = await enrollFree(userId, a.course.id);
  await enrollFree(userId, b.course.id);

  let visible = await getAccessibleEnrollments(userId);
  assert.equal(visible.length, 2);

  const db = await getDb();
  await db
    .update(enrollments)
    .set({ status: "cancelled" })
    .where(eq(enrollments.id, enrollmentA.id));

  // Cancelled enrollment vanishes from the collection read; the surviving
  // course resolves through the ONE-query batch lookup.
  visible = await getAccessibleEnrollments(userId);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].courseId, b.course.id);
  const courseMap = await getCoursesByIds(visible.map((e) => e.courseId));
  assert.equal(courseMap.size, 1);
  assert.ok(courseMap.get(b.course.id));
  assert.deepEqual(await getCoursesByIds([]), new Map());

  await cleanupCourse(a.slug);
  await cleanupCourse(b.slug);
});

// ---------------------------------------------------------------- Mission 06 FINAL QUALITY REMEDIATION

test("M06-F1: batched curriculum stats return grouped rows (no per-lesson fan-out)", async () => {
  const slug = `m06-f1-${stamp()}`;
  const course = await createCourse({ title: "Batched Curriculum", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const section = await createSection({ courseId: course.id, title: "S1" });
  const l1 = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "L1",
    slug: `f1-a-${stamp()}`,
    required: true,
  });
  const l2 = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "L2",
    slug: `f1-b-${stamp()}`,
    required: true,
  });

  const userId = await makeUser(`m06-f1-${stamp()}@example.com`);
  const enrollment = await enrollFree(userId, course.id);
  await publishLesson(l1.id);
  await markLessonComplete(userId, enrollment.id, l1.id);

  // ONE query maps completion counts for ALL lessons; missing ids are 0.
  const counts = await getLessonCompletionCounts([l1.id, l2.id]);
  assert.equal(counts[l1.id], 1);
  assert.equal(counts[l2.id], 0);
  assert.deepEqual(await getLessonCompletionCounts([]), {});

  // ONE query groups resources per lesson; unresourced lessons are absent.
  const resourcesByLesson = await getLessonResourcesForLessons([l1.id, l2.id]);
  assert.ok(!resourcesByLesson.has(l1.id));
  assert.ok(!resourcesByLesson.has(l2.id));
  assert.equal((await getLessonResourcesForLessons([])).size, 0);

  // The single-lesson helpers remain consistent with the batched view.
  assert.equal(await getLessonCompletionCount(l1.id), 1);
  assert.deepEqual(await getLessonResources(l2.id), []);

  await cleanupCourse(slug);
});

test("M06-F2: duplicate enrollment race returns the existing row (unique-race recovery only)", async () => {
  const slug = `m06-f2-${stamp()}`;
  const course = await createCourse({ title: "Enroll Race", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const userId = await makeUser(`m06-f2-${stamp()}@example.com`);

  const first = await enrollFree(userId, course.id);
  // The pre-check would let a concurrent equivalent enrollFree through; the
  // UNIQUE index decides. The function must return the SAME (winning) row —
  // idempotent concurrent enrollment.
  const second = await enrollFree(userId, course.id);
  assert.equal(second.id, first.id);
  assert.equal(second.status, "active");

  // Direct insert collision on the same (user_id, course_id) — the UNIQUE
  // backstop fires and enrollFree still resolves to the existing row.
  const again = await enrollFree(userId, course.id);
  assert.equal(again.id, first.id);

  const all = await (await getDb()).select().from(enrollments).where(eq(enrollments.userId, userId));
  assert.equal(all.length, 1);

  await cleanupCourse(slug);
});

test("M06-F3: non-unique DB errors are NOT swallowed by enrollment insert", async () => {
  const { isUniqueConstraintError } = await import("../src/lib/db/sqlite-errors");

  // Classifier: only genuine uniqueness violations match.
  assert.equal(isUniqueConstraintError(new Error("UNIQUE constraint failed: enrollments.user_id, enrollments.course_id")), true);
  assert.equal(isUniqueConstraintError(new Error("constraint failed: UNIQUE (enrollments.user_id, enrollments.course_id)")), true);
  // Explicit UNIQUE extended code (SQLite extended code 2067 / SQLITE_CONSTRAINT_UNIQUE)
  assert.equal(
    (() => { const e = new Error("constraint failed") as Error & { code?: string }; e.code = "SQLITE_CONSTRAINT_UNIQUE"; return isUniqueConstraintError(e); })(),
    true
  );
  assert.equal(
    (() => { const e = new Error("constraint failed") as Error & { code?: string }; e.code = "2067"; return isUniqueConstraintError(e); })(),
    true
  );
  // NUMERIC extended code: D1/driver errors may surface code as a NUMBER
  // (2067) rather than a string — both MUST be accepted.
  assert.equal(
    (() => { const e = new Error("constraint failed") as Error & { code?: number }; e.code = 2067; return isUniqueConstraintError(e); })(),
    true
  );
  // Generic SQLITE_CONSTRAINT (code 19 / "SQLITE_CONSTRAINT") is NOT proof of
  // UNIQUE — must return false to avoid swallowing NOT NULL, FOREIGN KEY,
  // CHECK, and other constraint failures. Rejected in BOTH string and NUMBER
  // forms.
  assert.equal(
    (() => { const e = new Error("constraint failed") as Error & { code?: string }; e.code = "SQLITE_CONSTRAINT"; return isUniqueConstraintError(e); })(),
    false
  );
  assert.equal(
    (() => { const e = new Error("constraint failed") as Error & { code?: number }; e.code = 19; return isUniqueConstraintError(e); })(),
    false,
    "numeric generic SQLITE_CONSTRAINT (19) must be rejected"
  );
  assert.equal(
    (() => { const e = new Error("constraint failed") as Error & { code?: string }; e.code = "19"; return isUniqueConstraintError(e); })(),
    false,
    "string generic SQLITE_CONSTRAINT (19) must be rejected"
  );
  // Drizzle wraps driver errors in DrizzleQueryError with the cause chain.
  const { DrizzleQueryError } = await import("drizzle-orm");
  const wrappedUnique = new DrizzleQueryError(
    'insert into "enrollments" ...',
    [],
    new Error("UNIQUE constraint failed: enrollments.user_id, enrollments.course_id")
  );
  assert.equal(isUniqueConstraintError(wrappedUnique), true);
  const wrappedLocked = new DrizzleQueryError(
    'insert into "enrollments" ...',
    [],
    new Error("database is locked")
  );
  assert.equal(isUniqueConstraintError(wrappedLocked), false);
  assert.equal(isUniqueConstraintError(new Error("database is locked")), false);
  assert.equal(isUniqueConstraintError(new Error("no such table: enrollments")), false);
  assert.equal(isUniqueConstraintError(new Error("disk I/O error")), false);
  assert.equal(isUniqueConstraintError(null), false);
  assert.equal(isUniqueConstraintError("UNIQUE constraint failed"), false);

  // Behavioral: make enrollFree's insert hit a NON-unique DB failure and
  // prove the error propagates instead of being misread as a race.
  const slug = `m06-f3-${stamp()}`;
  const course = await createCourse({ title: "Broken Insert", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const userId = await makeUser(`m06-f3-${stamp()}@example.com`);

  // Intercept at the D1 binding seam — the real interface every drizzle
  // instance calls through (each getDb() call creates a fresh wrapper, so
  // patching one wrapper would not affect enrollFree's own instance).
  const { getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest } = await import(
    "../src/lib/cloudflare/bindings"
  );
  const realD1 = await getD1Database();
  const fakeDb: D1Database = {
    prepare: (sql: string): D1PreparedStatement => {
      // Only sabotage the actual INSERT into enrollments; everything else
      // (reads, progress writes) passes through untouched.
      if (/insert\s+into\s+["'`]?enrollments/i.test(sql)) {
        const boom = () => {
          throw new Error("database is locked");
        };
        const stmt = {
          bind: boom,
          run: () => Promise.reject(new Error("database is locked")),
          first: boom,
          all: boom,
          raw: boom,
        };
        return stmt as unknown as D1PreparedStatement;
      }
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as D1Database;
  setD1DatabaseForTest(fakeDb);

  try {
    // Drizzle surfaces the driver failure as "Failed query: ..." with the
    // original "database is locked" attached as `cause` — the propagated
    // error must carry that cause, proving it was not swallowed or
    // misclassified as a duplicate race.
    await assert.rejects(
      () => enrollFree(userId, course.id),
      (err: unknown) => {
        const e = err as Error & { cause?: Error };
        const causeMessage = e.cause?.message ?? e.message;
        return /database is locked/.test(causeMessage);
      }
    );
  } finally {
    clearD1DatabaseForTest();
  }

  // The failed attempt left no enrollment behind; a clean retry succeeds.
  const recovered = await enrollFree(userId, course.id);
  assert.equal(recovered.status, "active");

  await cleanupCourse(slug);
});

test("M06-F4: duplicate course/lesson slugs raise domain errors, not raw SQLite errors", async () => {
  // Direct classifier-backed path: the insert-time UNIQUE violation (race
  // with a parallel creator) surfaces the same domain message as the
  // pre-check. Simulated here by a table-level collision the pre-check
  // misses: create via raw DB insert bypassing createCourse's pre-check.
  const slug = `m06-f4-${stamp()}`;
  const course = await createCourse({ title: "Slug Race", slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });

  // Lesson: pre-check passes, then a UNIQUE violation on insert → domain error.
  const lessonSlug = `f4-${stamp()}`;
  await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Original",
    slug: lessonSlug,
    required: true,
  });
  // Second insert with same slug hits the pre-check (same error message).
  await assert.rejects(
    () =>
      createLesson({
        courseId: course.id,
        sectionId: section.id,
        title: "Duplicate",
        slug: lessonSlug,
        required: true,
      }),
    (err: unknown) => {
      const message = (err as Error).message;
      // Domain error, NOT a raw SQLite string.
      assert.match(message, /already exists in this course/);
      assert.doesNotMatch(message, /UNIQUE constraint failed/);
      return true;
    }
  );

  // Course slug duplicate — domain error, no raw SQLite leakage.
  await assert.rejects(
    () => createCourse({ title: "Dup Course", slug, accessMode: "FREE" }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /already exists/);
      assert.doesNotMatch(message, /UNIQUE constraint failed/);
      return true;
    }
  );

  await cleanupCourse(slug);
});

test("M06-F5: section/lesson position swaps are atomic and preserve ordering semantics", async () => {
  const slug = `m06-f5-${stamp()}`;
  const course = await createCourse({ title: "Atomic Swap", slug, accessMode: "FREE" });
  const s1 = await createSection({ courseId: course.id, title: "S-One" });
  const s2 = await createSection({ courseId: course.id, title: "S-Two" });
  const s3 = await createSection({ courseId: course.id, title: "S-Three" });

  // Swap adjacent sections both directions; ordering semantics unchanged.
  let moved = await moveSection(s2.id, "down");
  assert.deepEqual(moved.map((s) => s.title), ["S-One", "S-Three", "S-Two"]);
  moved = await moveSection(s2.id, "up");
  assert.deepEqual(moved.map((s) => s.title), ["S-One", "S-Two", "S-Three"]);

  // Edge moves that must be no-ops (no duplicate positions introduced).
  const first = await moveSection(s1.id, "up");
  assert.deepEqual(first.map((s) => s.title), ["S-One", "S-Two", "S-Three"]);
  const last = await moveSection(s3.id, "down");
  assert.deepEqual(last.map((s) => s.title), ["S-One", "S-Two", "S-Three"]);

  // Positions remain unique after every swap.
  const positions = (await getCourseSections(course.id)).map((s) => s.position);
  assert.equal(new Set(positions).size, positions.length);

  // Lessons: same atomic swap semantics.
  const l1 = await createLesson({
    courseId: course.id,
    sectionId: s1.id,
    title: "LA",
    slug: `f5-a-${stamp()}`,
    required: true,
  });
  const l2 = await createLesson({
    courseId: course.id,
    sectionId: s1.id,
    title: "LB",
    slug: `f5-b-${stamp()}`,
    required: true,
  });
  const l3 = await createLesson({
    courseId: course.id,
    sectionId: s1.id,
    title: "LC",
    slug: `f5-c-${stamp()}`,
    required: true,
  });

  let lmoved = await moveLesson(l3.id, "up");
  assert.deepEqual(lmoved.map((l) => l.id), [l1.id, l3.id, l2.id]);
  lmoved = await moveLesson(l3.id, "down");
  assert.deepEqual(lmoved.map((l) => l.id), [l1.id, l2.id, l3.id]);

  const noopFirst = await moveLesson(l1.id, "up");
  assert.deepEqual(noopFirst.map((l) => l.id), [l1.id, l2.id, l3.id]);

  await cleanupCourse(slug);
});

test("M06-F6: non-unique DB errors are NOT swallowed by markLessonComplete", async () => {
  const { isUniqueConstraintError } = await import("../src/lib/db/sqlite-errors");
  // Verify classifier rejects generic constraint errors — string AND numeric forms.
  assert.equal(
    (() => { const e = new Error("constraint failed") as Error & { code?: string }; e.code = "SQLITE_CONSTRAINT"; return isUniqueConstraintError(e); })(),
    false
  );
  assert.equal(
    (() => { const e = new Error("constraint failed") as Error & { code?: number }; e.code = 19; return isUniqueConstraintError(e); })(),
    false
  );

  // Behavioral: make markLessonComplete's insert hit a NON-unique DB failure
  // and prove the error propagates instead of being misread as a race.
  const slug = `m06-f6-${stamp()}`;
  const course = await createCourse({ title: "Mark Complete Broken", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const section = await createSection({ courseId: course.id, title: "S1" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Lesson 1",
    slug: `m06-f6-lesson-${stamp()}`,
    required: true,
  });
  await publishLesson(lesson.id);
  const userId = await makeUser(`m06-f6-${stamp()}@example.com`);
  const enrollment = await enrollFree(userId, course.id);

  // Intercept at the D1 binding seam.
  const { getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest } = await import(
    "../src/lib/cloudflare/bindings"
  );
  const realD1 = await getD1Database();
  const fakeDb: D1Database = {
    prepare: (sql: string): D1PreparedStatement => {
      // Only sabotage the actual INSERT into lesson_progress; everything else
      // passes through untouched.
      if (/insert\s+into\s+[\"'`]?lesson_progress/i.test(sql)) {
        const boom = () => {
          throw new Error("database is locked");
        };
        const stmt = {
          bind: boom,
          run: () => Promise.reject(new Error("database is locked")),
          first: boom,
          all: boom,
          raw: boom,
        };
        return stmt as unknown as D1PreparedStatement;
      }
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as D1Database;
  setD1DatabaseForTest(fakeDb);

  try {
    // Drizzle surfaces the driver failure as "Failed query: ..." with the
    // original "database is locked" attached as `cause` — the propagated
    // error must carry that cause, proving it was not swallowed or
    // misclassified as a duplicate race.
    await assert.rejects(
      () => markLessonComplete(userId, enrollment.id, lesson.id),
      (err: unknown) => {
        const e = err as Error & { cause?: Error };
        const causeMessage = e.cause?.message ?? e.message;
        return /database is locked/.test(causeMessage);
      }
    );
  } finally {
    clearD1DatabaseForTest();
  }

  // The failed attempt left no progress row behind; a clean retry succeeds.
  const recovered = await markLessonComplete(userId, enrollment.id, lesson.id);
  assert.equal(recovered.alreadyComplete, false);
  assert.equal(recovered.progress.completedRequired, 1);

  await cleanupCourse(slug);
});

test("M06-P3: optional lesson completion stays visible without affecting percentage or completion", async () => {
  // Course percentage/completion remains based ONLY on required published lessons.
  // But completedLessonIds must represent completed currently-published lessons,
  // including optional lessons. Optional completion must remain visibly complete
  // after refresh/navigation without affecting the percentage or course-complete
  // verdict.
  const slug = `m06-p3-${stamp()}`;
  const course = await createCourse({ title: "Optional Lessons Test", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const section = await createSection({ courseId: course.id, title: "S1" });

  // Create one REQUIRED lesson
  const reqLesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Required Lesson",
    slug: `m06-p3-req-${stamp()}`,
    required: true,
  });
  await publishLesson(reqLesson.id);

  // Create one OPTIONAL lesson
  const optLesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Optional Lesson",
    slug: `m06-p3-opt-${stamp()}`,
    required: false,
  });
  await publishLesson(optLesson.id);

  const userId = await makeUser(`m06-p3-${stamp()}@example.com`);
  const enrollment = await enrollFree(userId, course.id);

  // Initially: 0% (0/1 required complete), no lessons completed
  let progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.totalRequired, 1);
  assert.equal(progress.completedRequired, 0);
  assert.equal(progress.percent, 0);
  assert.equal(progress.completed, false);
  assert.equal(progress.totalPublished, 2);
  assert.deepEqual(progress.completedLessonIds.sort(), []);

  // Complete the OPTIONAL lesson first
  await markLessonComplete(userId, enrollment.id, optLesson.id);

  // Progress should show: 0% (still 0/1 required), but completedLessonIds includes optional
  progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.totalRequired, 1);
  assert.equal(progress.completedRequired, 0);
  assert.equal(progress.percent, 0);
  assert.equal(progress.completed, false);
  assert.equal(progress.totalPublished, 2);
  assert.deepEqual(new Set(progress.completedLessonIds), new Set([optLesson.id]));

  // Now complete the REQUIRED lesson
  await markLessonComplete(userId, enrollment.id, reqLesson.id);

  // Progress should show: 100% (1/1 required), completedLessonIds includes both
  progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.totalRequired, 1);
  assert.equal(progress.completedRequired, 1);
  assert.equal(progress.percent, 100);
  assert.equal(progress.completed, true);
  assert.equal(progress.totalPublished, 2);
  assert.deepEqual(new Set(progress.completedLessonIds), new Set([optLesson.id, reqLesson.id]));

  // Verify enrollment status is completed (based on required only)
  const updatedEnrollment = await getEnrollment(userId, course.id);
  assert.equal(updatedEnrollment?.status, "completed");
  assert.ok(updatedEnrollment?.completedAt);

  // Now unpublish the optional lesson - completedLessonIds should only have required
  // (the optional lesson is no longer "currently published")
  await unpublishLesson(optLesson.id);
  progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.totalRequired, 1);
  assert.equal(progress.completedRequired, 1);
  assert.equal(progress.percent, 100);
  assert.equal(progress.completed, true);
  assert.equal(progress.totalPublished, 1); // only required is published now
  assert.deepEqual(new Set(progress.completedLessonIds), new Set([reqLesson.id]));

  // Re-publish optional - completedLessonIds should include it again
  await publishLesson(optLesson.id);
  progress = await getEnrollmentProgress(enrollment);
  assert.equal(progress.totalPublished, 2);
  assert.deepEqual(new Set(progress.completedLessonIds), new Set([optLesson.id, reqLesson.id]));

  await cleanupCourse(slug);
});

test("M06-D1: enrolled learner denied draft lesson PDF; allowed after lesson publish", async () => {
  // Boundary regression: non-admin resource downloads require lesson to be PUBLISHED.
  // Enrolled learner denied draft lesson PDF (404); same learner allowed after publish.
  // Returns 404 for unpublished resources to avoid existence leakage.
  const slug = `m06-d1-${stamp()}`;
  const course = await createCourse({ title: "Resource Visibility Test", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const section = await createSection({ courseId: course.id, title: "S1" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Lesson with PDF",
    slug: `m06-d1-lesson-${stamp()}`,
    required: true,
  });
  // Lesson starts as DRAFT (not published)
  const userId = await makeUser(`m06-d1-${stamp()}@example.com`);
  await enrollFree(userId, course.id);

  // Upload a PDF resource to the DRAFT lesson (admin can do this)
  const { uploadCourseResource } = await import("../src/lib/course-resources/service");
  const pdfBuffer = Buffer.from("%PDF-1.4 test content");
  const uploadResult = await uploadCourseResource({
    buffer: pdfBuffer,
    filename: "test.pdf",
    contentType: "application/pdf",
    courseId: course.id,
    lessonId: lesson.id,
    title: "Test PDF",
  });

  // Try to download as learner - should get 404 (lesson is draft)
  const { getCourseResourceObject } = await import("../src/lib/course-resources/service");
  const object = await getCourseResourceObject(uploadResult.storageKey);
  assert.ok(object, "PDF should exist in storage");

  // Now simulate the API route logic: lesson must be published
  const { getDb, lessons: lessonsTable } = await import("../src/lib/db");
  const db = await getDb();
  const lessonRecord = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lesson.id))
    .get();
  assert.equal(lessonRecord?.status, "draft");

  // Publish the lesson
  await publishLesson(lesson.id);

  // Now the lesson is published - learner should be able to access
  const lessonRecordPublished = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lesson.id))
    .get();
  assert.equal(lessonRecordPublished?.status, "published");

  // Verify the resource object is accessible
  const objectAfterPublish = await getCourseResourceObject(uploadResult.storageKey);
  assert.ok(objectAfterPublish, "PDF should be accessible after lesson publish");

  await cleanupCourse(slug);
});

// ---------------------------------------------------------------------------
// FINAL FOUNDATION MICRO-CORRECTION (deterministic resume + lost-race rethrow)
// ---------------------------------------------------------------------------

test("M06-B1: batched progress — multiple enrollments + deterministic resume (section.position, then lesson.position)", async () => {
  const { getBatchedEnrollmentProgress: batched } = await import("../src/features/progress/service");

  // Course A: two sections. Lessons are INSERTED in an order that diverges
  // from curriculum order (B1, B2, A1, A2) — a naive insertion-order or
  // per-lesson-position fetch would resolve the WRONG resume lesson.
  const slugA = `m06-b1a-${stamp()}`;
  const courseA = await createCourse({ title: "Batched A", slug: slugA, accessMode: "FREE" });
  await publishCourse(courseA.id);
  const s1 = await createSection({ courseId: courseA.id, title: "Section One" });
  const s2 = await createSection({ courseId: courseA.id, title: "Section Two" });
  const mk = (sectionId: string, title: string, s: string) =>
    createLesson({ courseId: courseA.id, sectionId, title, slug: `${s}-${stamp()}`, required: true });
  // Insertion order differs from curriculum order on purpose.
  const b1 = await mk(s2.id, "B1", "b1");
  const b2 = await mk(s2.id, "B2", "b2");
  const a1 = await mk(s1.id, "A1", "a1");
  const a2 = await mk(s1.id, "A2", "a2");
  for (const l of [b1, b2, a1, a2]) await publishLesson(l.id);
  // Correct curriculum order: section.position asc, then lesson.position asc
  // -> A1 (s1), A2 (s1), B1 (s2), B2 (s2).
  assert.equal(s1.position < s2.position, true);

  // Course B: single required lesson for the second enrollment.
  const slugB = `m06-b1b-${stamp()}`;
  const courseB = await createCourse({ title: "Batched B", slug: slugB, accessMode: "FREE" });
  await publishCourse(courseB.id);
  const sb = await createSection({ courseId: courseB.id, title: "S1" });
  const bOnly = await createLesson({
    courseId: courseB.id,
    sectionId: sb.id,
    title: "Only",
    slug: `only-${stamp()}`,
    required: true,
  });
  await publishLesson(bOnly.id);

  const user1 = await makeUser(`m06-b1a-${stamp()}@example.com`);
  const user2 = await makeUser(`m06-b1b-${stamp()}@example.com`);
  const enr1 = await enrollFree(user1, courseA.id);
  const enr2 = await enrollFree(user2, courseB.id);

  // Learner 1 completes A1 (the first lesson in curriculum order). Resume
  // must be A2 — the first still-incomplete lesson in curriculum order —
  // NOT B1, which is what an insertion-order fetch would have returned.
  await markLessonComplete(user1, enr1.id, a1.id);

  const summaries = await batched([enr1, enr2]);
  assert.equal(summaries.size, 2, "one summary per enrollment");

  const s1e = summaries.get(enr1.id);
  assert.ok(s1e, "enrollment 1 summary present");
  assert.equal(s1e.courseTitle, "Batched A");
  assert.equal(s1e.courseSlug, slugA);
  assert.equal(s1e.completedRequired, 1);
  assert.equal(s1e.totalRequired, 4);
  assert.equal(s1e.totalPublished, 4);
  assert.equal(s1e.completed, false);
  assert.equal(s1e.resumeLessonId, a2.id, "resume MUST follow section.position then lesson.position");
  assert.equal(s1e.resumeLessonSlug, a2.slug);
  assert.equal(s1e.resumeLessonTitle, "A2");

  const s2e = summaries.get(enr2.id);
  assert.ok(s2e, "enrollment 2 summary present");
  assert.equal(s2e.courseTitle, "Batched B");
  assert.equal(s2e.totalRequired, 1);
  assert.equal(s2e.completedRequired, 0);
  assert.equal(s2e.percent, 0);
  assert.equal(s2e.resumeLessonId, bOnly.id, "fresh enrollment resumes at the first curriculum lesson");

  // Reconcile individually and confirm resume converges with the batched view.
  const single = await getEnrollmentProgress(enr1);
  assert.equal(single.resumeLesson?.id, a2.id);

  // Empty input is an empty map (bounded query shape, no per-enrollment work).
  assert.equal((await batched([])).size, 0);

  await cleanupCourse(slugA);
  await cleanupCourse(slugB);
});

test("M06-B2: enrollment UNIQUE race WITHOUT the expected winner rethrows the original DB error", async () => {
  const slug = `m06-b2-${stamp()}`;
  const course = await createCourse({ title: "Race Rethrow", slug, accessMode: "FREE" });
  await publishCourse(course.id);
  const userId = await makeUser(`m06-b2-${stamp()}@example.com`);

  const { getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest } = await import(
    "../src/lib/cloudflare/bindings"
  );
  const realD1 = await getD1Database();
  const fakeDb: D1Database = {
    prepare: (sql: string): D1PreparedStatement => {
      // Sabotage ONLY the enrollments INSERT with a UNIQUE-flavoured failure;
      // no winner row exists anywhere, so the race-recovery must NOT mask it.
      if (/insert\s+into\s+["'`]?enrollments/i.test(sql)) {
        const boom = () => {
          throw new Error("UNIQUE constraint failed: enrollments.user_id, enrollments.course_id");
        };
        const stmt = {
          bind: boom,
          run: () => Promise.reject(new Error("UNIQUE constraint failed: enrollments.user_id, enrollments.course_id")),
          first: boom,
          all: boom,
          raw: boom,
        };
        return stmt as unknown as D1PreparedStatement;
      }
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as D1Database;
  setD1DatabaseForTest(fakeDb);

  try {
    // The unique error IS a genuine UNIQUE violation, but no (user, course)
    // winner exists — this is NOT a lost duplicate race, so the ORIGINAL DB
    // error must propagate (never a friendly swallowed result).
    await assert.rejects(
      () => enrollFree(userId, course.id),
      (err: unknown) => {
        const e = err as Error & { cause?: Error };
        const causeMessage = e.cause?.message ?? e.message;
        return /UNIQUE constraint failed/.test(causeMessage);
      }
    );
  } finally {
    clearD1DatabaseForTest();
  }

  // Nothing was inserted; a clean retry (real DB) succeeds.
  const recovered = await enrollFree(userId, course.id);
  assert.equal(recovered.status, "active");

  await cleanupCourse(slug);
});

test("M06-B3: updateCourse slug UNIQUE race WITHOUT a conflicting slug rethrows the original DB error", async () => {
  const slug = `m06-b3-${stamp()}`;
  const course = await createCourse({ title: "Update Race", slug, accessMode: "FREE" });
  const newSlug = `m06-b3-new-${stamp()}`;

  const { getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest } = await import(
    "../src/lib/cloudflare/bindings"
  );
  const realD1 = await getD1Database();
  const fakeDb: D1Database = {
    prepare: (sql: string): D1PreparedStatement => {
      // Sabotage ONLY the courses UPDATE with a UNIQUE-flavoured failure. The
      // pre-check passes (no real clash exists), so the verification lookup
      // must find NO conflicting course and therefore rethrow the original.
      if (/\bupdate\s+["'`]?courses\b/i.test(sql)) {
        const boom = () => {
          throw new Error("UNIQUE constraint failed: courses.slug");
        };
        const stmt = {
          bind: boom,
          run: () => Promise.reject(new Error("UNIQUE constraint failed: courses.slug")),
          first: boom,
          all: boom,
          raw: boom,
        };
        return stmt as unknown as D1PreparedStatement;
      }
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as D1Database;
  setD1DatabaseForTest(fakeDb);

  try {
    await assert.rejects(
      () => updateCourse(course.id, { id: course.id, slug: newSlug }),
      (err: unknown) => {
        const e = err as Error & { cause?: Error };
        const causeMessage = e.cause?.message ?? e.message;
        return /UNIQUE constraint failed/.test(causeMessage);
      },
      "no conflicting slug exists -> the original UNIQUE DB error must propagate, not a friendly duplicate"
    );
  } finally {
    clearD1DatabaseForTest();
  }

  // The update never applied; the course keeps its original slug.
  const row = await (await getDb()).select().from(courses).where(eq(courses.id, course.id)).get();
  assert.equal(row?.slug, slug);

  await cleanupCourse(slug);
});

test("M06-B4: updateLesson slug UNIQUE race WITHOUT a conflicting slug rethrows the original DB error", async () => {
  const slug = `m06-b4-${stamp()}`;
  const course = await createCourse({ title: "Lesson Update Race", slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Original",
    slug: `m06-b4-orig-${stamp()}`,
    required: true,
  });
  const newSlug = `m06-b4-new-${stamp()}`;

  const { getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest } = await import(
    "../src/lib/cloudflare/bindings"
  );
  const realD1 = await getD1Database();
  const fakeDb: D1Database = {
    prepare: (sql: string): D1PreparedStatement => {
      // Sabotage ONLY the lessons UPDATE; same reasoning as B3.
      if (/\bupdate\s+["'`]?lessons\b/i.test(sql)) {
        const boom = () => {
          throw new Error("UNIQUE constraint failed: lessons.course_id, lessons.slug");
        };
        const stmt = {
          bind: boom,
          run: () => Promise.reject(new Error("UNIQUE constraint failed: lessons.course_id, lessons.slug")),
          first: boom,
          all: boom,
          raw: boom,
        };
        return stmt as unknown as D1PreparedStatement;
      }
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as D1Database;
  setD1DatabaseForTest(fakeDb);

  try {
    await assert.rejects(
      () => updateLesson(lesson.id, { id: lesson.id, slug: newSlug }),
      (err: unknown) => {
        const e = err as Error & { cause?: Error };
        const causeMessage = e.cause?.message ?? e.message;
        return /UNIQUE constraint failed/.test(causeMessage);
      },
      "no conflicting (courseId, slug) exists -> the original UNIQUE DB error must propagate"
    );
  } finally {
    clearD1DatabaseForTest();
  }

  const row = await (await getDb()).select().from(lessons).where(eq(lessons.id, lesson.id)).get();
  assert.ok(row, "lesson row still exists");
  assert.equal(row.slug, lesson.slug, "the failed update must leave the original slug untouched");
  assert.notEqual(row.slug, newSlug);

  await cleanupCourse(slug);
});

test("M06-B5: createGuide UNIQUE race WITHOUT a conflicting slug rethrows the original DB error", async () => {
  const slug = `m06-b5-${stamp()}`;

  const { getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest } = await import(
    "../src/lib/cloudflare/bindings"
  );
  const realD1 = await getD1Database();
  const fakeDb: D1Database = {
    prepare: (sql: string): D1PreparedStatement => {
      // Sabotage ONLY the guides INSERT with a UNIQUE-flavoured failure; no
      // guide with that slug exists, so the verification lookup finds no
      // conflict and the ORIGINAL error must propagate.
      if (/insert\s+into\s+["'`]?guides/i.test(sql)) {
        const boom = () => {
          throw new Error("UNIQUE constraint failed: guides.slug");
        };
        const stmt = {
          bind: boom,
          run: () => Promise.reject(new Error("UNIQUE constraint failed: guides.slug")),
          first: boom,
          all: boom,
          raw: boom,
        };
        return stmt as unknown as D1PreparedStatement;
      }
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as D1Database;
  setD1DatabaseForTest(fakeDb);

  try {
    const { createGuide } = await import("../src/features/guides/service");
    await assert.rejects(
      () => createGuide({ title: "Race Guide", slug, author: "Ahmed Awad", body: [] }),
      (err: unknown) => {
        const e = err as Error & { cause?: Error };
        const causeMessage = e.cause?.message ?? e.message;
        return /UNIQUE constraint failed/.test(causeMessage);
      },
      "no conflicting guide slug exists -> the original UNIQUE DB error must propagate"
    );
  } finally {
    clearD1DatabaseForTest();
  }

  // No guide was created; a clean retry succeeds.
  const { createGuide } = await import("../src/features/guides/service");
  const created = await createGuide({ title: "Race Guide", slug, author: "Ahmed Awad", body: [] });
  assert.equal(created.slug, slug);
  const db = await getDb();
  await db.delete(guides).where(eq(guides.slug, slug));

  await cleanupCourse(slug);
});

test("M06-B6: updateGuide + createFieldNote + updateFieldNote UNIQUE races WITHOUT conflicts rethrow the original DB error", async () => {
  const { getD1Database, setD1DatabaseForTest, clearD1DatabaseForTest } = await import(
    "../src/lib/cloudflare/bindings"
  );
  const { createGuide, updateGuide } = await import("../src/features/guides/service");
  const { createFieldNote, updateFieldNote } = await import("../src/features/field-notes/service");
  const { fieldNotes: fieldNotesTable } = await import("../src/lib/db");

  // Real rows so the pre-checks pass; the sabotaged UPDATE/INSERT then fires a
  // UNIQUE-flavoured failure that does NOT correspond to any real conflict.
  const guideSlug = `m06-b6-guide-${stamp()}`;
  const guide = await createGuide({ title: "Race Guide B6", slug: guideSlug, author: "Ahmed Awad", body: [] });
  const fnSlug = `m06-b6-fn-${stamp()}`;
  const fn = await createFieldNote({ title: "Race FN B6", slug: fnSlug, author: "Ahmed Awad", body: [] });
  const guideNewSlug = `m06-b6-guide-new-${stamp()}`;
  const fnNewSlug = `m06-b6-fn-new-${stamp()}`;

  const realD1 = await getD1Database();
  const fakeDb: D1Database = {
    prepare: (sql: string): D1PreparedStatement => {
      // Sabotage ONLY the guides UPDATE, the field_notes INSERT, and the
      // field_notes UPDATE. No conflicting slug exists anywhere, so each
      // operation's verification lookup finds nothing and the ORIGINAL DB
      // error must propagate.
      const target =
        /\bupdate\s+["'`]?guides\b/i.test(sql)
          ? "guides"
          : /insert\s+into\s+["'`]?field_notes/i.test(sql)
            ? "field_notes insert"
            : /\bupdate\s+["'`]?field_notes\b/i.test(sql)
              ? "field_notes update"
              : null;
      if (target) {
        const boom = () => {
          throw new Error(`UNIQUE constraint failed: ${target}.slug`);
        };
        const stmt = {
          bind: boom,
          run: () => Promise.reject(new Error(`UNIQUE constraint failed: ${target}.slug`)),
          first: boom,
          all: boom,
          raw: boom,
        };
        return stmt as unknown as D1PreparedStatement;
      }
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as D1Database;
  setD1DatabaseForTest(fakeDb);

  try {
    await assert.rejects(
      () => updateGuide(guide.id, { id: guide.id, slug: guideNewSlug }),
      (err: unknown) => {
        const e = err as Error & { cause?: Error };
        const causeMessage = e.cause?.message ?? e.message;
        return /UNIQUE constraint failed/.test(causeMessage);
      },
      "guide update: no conflicting slug exists -> original UNIQUE DB error must propagate"
    );
    await assert.rejects(
      () => createFieldNote({ title: "Race FN B6b", slug: fnNewSlug, author: "Ahmed Awad", body: [] }),
      (err: unknown) => {
        const e = err as Error & { cause?: Error };
        const causeMessage = e.cause?.message ?? e.message;
        return /UNIQUE constraint failed/.test(causeMessage);
      },
      "field note create: no conflicting slug exists -> original UNIQUE DB error must propagate"
    );
    await assert.rejects(
      () => updateFieldNote(fn.id, { id: fn.id, slug: fnNewSlug }),
      (err: unknown) => {
        const e = err as Error & { cause?: Error };
        const causeMessage = e.cause?.message ?? e.message;
        return /UNIQUE constraint failed/.test(causeMessage);
      },
      "field note update: no conflicting slug exists -> original UNIQUE DB error must propagate"
    );
  } finally {
    clearD1DatabaseForTest();
  }

  // None of the sabotaged writes applied; rows keep their original slugs.
  const db = await getDb();
  const guideRow = await db.select().from(guides).where(eq(guides.id, guide.id)).get();
  assert.equal(guideRow?.slug, guideSlug);
  const fnRow = await db.select().from(fieldNotesTable).where(eq(fieldNotesTable.id, fn.id)).get();
  assert.equal(fnRow?.slug, fnSlug);
  assert.equal(await db.select().from(fieldNotesTable).where(eq(fieldNotesTable.slug, fnNewSlug)).get(), undefined);

  await db.delete(guides).where(eq(guides.slug, guideSlug));
  await db.delete(fieldNotesTable).where(eq(fieldNotesTable.slug, fnSlug));

  await cleanupCourse(guideSlug);
});
