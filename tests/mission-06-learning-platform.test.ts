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
} from "../src/features/courses/service";
import {
  enrollFree,
  getEnrollment,
  requireEnrollment,
} from "../src/features/enrollments/service";
import {
  getEnrollmentProgress,
  markLessonComplete,
} from "../src/features/progress/service";
import {
  extractYouTubeVideoId,
  isValidYouTubeUrl,
} from "../src/features/courses/youtube";
import { getCourseResourceObject } from "../src/lib/course-resources/service";
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
