import "./helpers/env";
import test from "node:test";
import assert from "node:assert/strict";
import { getLessonReadAccess } from "../src/features/courses/lesson-access";
import { formatMinutes, getCourseTimeStats, lessonMetaLabel, lessonTypeHint, parseCourseLanding } from "../src/features/courses/metadata";
import { createCourseSchema, updateCourseSchema, updateLessonSchema } from "../src/features/courses/types";
import { createCourse, createSection, createLesson, updateCourse, updateLesson, publishCourse, publishLesson, getPublishedLessonBySlug } from "../src/features/courses/service";
import { getDb, users, enrollments, lessonProgress } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { markLessonComplete } from "../src/features/progress/service";

const course = { id: "course", status: "published" as const };
const lesson = { courseId: course.id, status: "published" as const, isPreview: false };
const gateCases = [
  { name: "enrolled", enrolled: true, expected: "enrolled" },
  { name: "unenrolled preview", isPreview: true, expected: "preview" },
  { name: "unenrolled non-preview", expected: "denied" },
  { name: "draft preview lesson", isPreview: true, lessonStatus: "draft", expected: "denied" },
  { name: "archived preview lesson", isPreview: true, lessonStatus: "archived", expected: "denied" },
  { name: "unpublished course", isPreview: true, courseStatus: "draft", expected: "denied" },
  { name: "archived preview course", isPreview: true, courseStatus: "archived", expected: "denied" },
  { name: "existing enrollment retains archived course access", enrolled: true, courseStatus: "archived", expected: "enrolled" },
  { name: "enrollment cannot open draft course", enrolled: true, courseStatus: "draft", expected: "denied" },
  { name: "enrollment cannot open draft preview lesson", enrolled: true, isPreview: true, lessonStatus: "draft", expected: "denied" },
  { name: "anonymous preview", isPreview: true, signedIn: false, expected: "denied" },
  { name: "mismatched course", enrolled: true, courseId: "other", expected: "denied" },
] as const;
for (const row of gateCases) {
  test(`lesson read gate: ${row.name}`, () => {
    const input = row as { enrolled?: boolean; isPreview?: boolean; signedIn?: boolean; courseStatus?: "draft" | "published" | "archived"; lessonStatus?: "draft" | "published" | "archived"; courseId?: string };
    assert.equal(getLessonReadAccess({
      signedIn: input.signedIn ?? true,
      enrolled: input.enrolled ?? false,
      course: { ...course, status: input.courseStatus ?? course.status },
      lesson: { ...lesson, status: input.lessonStatus ?? lesson.status, isPreview: input.isPreview ?? false, courseId: input.courseId ?? course.id },
    }), row.expected);
  });
}

test("duration formatting includes zero and leaves missing time absent", () => {
  assert.equal(formatMinutes(8), "8 min");
  assert.equal(formatMinutes(0), "0 min");
  assert.equal(formatMinutes(null), null);
  assert.equal(formatMinutes(-1), null);
});

test("lesson meta label omits out-of-range durations", () => {
  assert.equal(lessonMetaLabel({ videoUrl: "https://youtu.be/x", durationMinutes: 8 }), "Video · 8 min");
  assert.equal(lessonMetaLabel({ videoUrl: null, durationMinutes: 8 }, true), "Reading + files · 8 min");
  assert.equal(lessonMetaLabel({ videoUrl: null, durationMinutes: null }), "Reading");
  assert.equal(lessonMetaLabel({ videoUrl: null, durationMinutes: 601 }), "Reading");
  assert.equal(lessonMetaLabel({ videoUrl: null, durationMinutes: -3 }), "Reading");
});

test("totals and remaining time include optional published lessons and ignore drafts and invalid durations", () => {
  const rows = [
    { id: "required", status: "published" as const, durationMinutes: 8, required: true },
    { id: "optional", status: "published" as const, durationMinutes: 12, required: false },
    { id: "untimed", status: "published" as const, durationMinutes: null },
    { id: "draft", status: "draft" as const, durationMinutes: 50 },
    { id: "archived", status: "archived" as const, durationMinutes: 50 },
    { id: "invalid", status: "published" as const, durationMinutes: 0 },
  ];
  assert.deepEqual(getCourseTimeStats(rows, ["required", "stale"]), { lessonCount: 4, totalMinutes: 20, minutesLeft: 12 });
  assert.equal(getCourseTimeStats(rows, ["required", "optional"]).minutesLeft, 0);
  assert.equal(getCourseTimeStats(rows).minutesLeft, 20);
});

test("no durations means no time estimate, including an empty curriculum", () => {
  assert.deepEqual(getCourseTimeStats([]), { lessonCount: 0, totalMinutes: null, minutesLeft: null });
  assert.equal(getCourseTimeStats([{ id: "untimed", status: "published", durationMinutes: null }]).minutesLeft, null);
});

test("lesson hints derive from existing video and resource data", () => {
  assert.equal(lessonTypeHint({ videoUrl: null }), "Reading");
  assert.equal(lessonTypeHint({ videoUrl: "video" }), "Video");
  assert.equal(lessonTypeHint({ videoUrl: null }, true), "Reading + files");
});

test("landing JSON parsing rejects malformed JSON, wrong shapes and excessive content", () => {
  for (const raw of [null, "{", "null", '{}', '[1]', JSON.stringify(Array(13).fill("outcome"))]) {
    assert.deepEqual(parseCourseLanding({ outcomes: raw, faq: raw }), { outcomes: [], faq: [] });
  }
  assert.deepEqual(parseCourseLanding({ outcomes: '["Outcome"]', faq: '[{"q":"Question?","a":"Answer"}]' }), { outcomes: ["Outcome"], faq: [{ q: "Question?", a: "Answer" }] });
});

test("Studio duration validation accepts only optional integers 1–600 and boolean preview", () => {
  for (const durationMinutes of [1, 600, null, undefined]) assert.equal(updateLessonSchema.safeParse({ id: "lesson", durationMinutes, isPreview: true }).success, true);
  for (const durationMinutes of [0, 601, 1.5, "8"]) assert.equal(updateLessonSchema.safeParse({ id: "lesson", durationMinutes }).success, false);
  assert.equal(updateLessonSchema.safeParse({ id: "lesson", isPreview: "true" }).success, false);
});

test("Studio caps landing arrays and all text sizes on create and update", () => {
  const invalid = [
    { outcomes: Array(13).fill("outcome") }, { outcomes: ["x".repeat(201)] },
    { faq: Array(13).fill({ q: "Q", a: "A" }) }, { faq: [{ q: "x".repeat(201), a: "A" }] },
    { faq: [{ q: "Q", a: "x".repeat(1501) }] }, { faq: [{ q: "Q", a: "" }] },
    { audience: "x".repeat(2001) }, { instructorName: "x".repeat(161) }, { instructorBio: "x".repeat(1501) },
  ];
  for (const fields of invalid) {
    assert.equal(updateCourseSchema.safeParse({ id: "course", ...fields }).success, false);
    assert.equal(createCourseSchema.safeParse({ title: "Course", slug: "course", ...fields }).success, false);
  }
});

test.before(() => migrateLocalDb());
test.after(() => disposeCloudflareBindings());

test("metadata persists, clears and defaults safely; preview never grants progress writes", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const created = await createCourse({ title: "Conversion fixture", slug: `conversion-${suffix}`, outcomes: ["Initial outcome"], faq: [{ q: "Question?", a: "Answer" }] });
  assert.deepEqual(parseCourseLanding(created).outcomes, ["Initial outcome"]);
  const section = await createSection({ courseId: created.id, title: "Section" });
  const first = await createLesson({ courseId: created.id, sectionId: section.id, title: "Preview fixture", slug: "preview" });
  assert.equal(first.isPreview, false);
  assert.equal(first.durationMinutes, null);
  const updated = await updateLesson(first.id, { id: first.id, isPreview: true, durationMinutes: 8 });
  assert.equal(updated.isPreview, true);
  assert.equal(updated.durationMinutes, 8);
  await publishLesson(first.id);
  await publishCourse(created.id);
  assert.equal((await getPublishedLessonBySlug(created.id, first.slug))?.isPreview, true);
  const cleared = await updateCourse(created.id, { id: created.id, outcomes: null, faq: [], audience: "Audience", instructorName: "Instructor", instructorBio: "Bio" });
  assert.deepEqual(parseCourseLanding(cleared), { outcomes: [], faq: [] });
  assert.equal(cleared.audience, "Audience");
  assert.equal(cleared.instructorBio, "Bio");
  const db = await getDb();
  const userId = `conversion-user-${suffix}`;
  await db.insert(users).values({ id: userId, name: "Fixture", email: `${userId}@example.test`, emailVerified: false, role: "user", createdAt: new Date(), updatedAt: new Date() });
  await assert.rejects(() => markLessonComplete(userId, "missing-enrollment", first.id), /Enrollment not found/);
  const enrollmentId = `conversion-enrollment-${suffix}`;
  await db.insert(enrollments).values({ id: enrollmentId, userId, courseId: created.id, status: "cancelled", enrolledAt: new Date() });
  await assert.rejects(() => markLessonComplete(userId, enrollmentId, first.id), /no longer active/);
  assert.equal((await db.select().from(lessonProgress)).length, 0);
  assert.equal((await updateLesson(first.id, { id: first.id, durationMinutes: null, isPreview: false })).durationMinutes, null);
});
