import test from "node:test";
import assert from "node:assert/strict";
import {
  getDb,
  users,
  courses,
  courseSections,
  lessons,
  lessonResources,
  enrollments,
  lessonProgress,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { requireAdmin, requireUser } from "../src/lib/auth";
import {
  createCourse,
  publishCourse,
  archiveCourse,
  createSection,
  moveSection,
  createLesson,
  publishLesson,
  moveLesson,
  getPublishedCourseBySlug,
  getPublishedLessonBySlug,
  getPublishedCourseLessons,
  getLearnerCourseBySlug,
  getCourseCurriculum,
  getCourseEnrollmentCounts,
  getPublishedLessonCounts,
} from "../src/features/courses/service";
import {
  enrollFree,
  getEnrollment,
  requireEnrollment,
} from "../src/features/enrollments/service";
import { hasLearnerAccess } from "../src/features/enrollments/access";
import {
  getEnrollmentProgress,
  markLessonComplete,
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
