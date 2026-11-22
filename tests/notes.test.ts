/**
 * PRIVATE LESSON NOTES DOMAIN TESTS
 * ---------------------------------------------------------------------------
 * - body schema: NFC + trim, 10,000 cap, control-character rejection;
 * - empty saves delete; upsert keeps one row per (user, lesson);
 * - save authorization matrix (signed out, unenrolled, preview, cancelled,
 *   enrolled, lesson from another course);
 * - owner isolation for read, overwrite and delete;
 * - 1 s per-user/per-lesson save throttle;
 * - listMyCourseNotes curriculum order + course/user scoping;
 * - cascade delete with the lesson;
 * - cancelled enrollments keep rows but reads are refused until re-enrolled.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import {
  enrollments,
  getDb,
  lessonNotes,
  lessons,
  type Lesson,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import {
  createCourse,
  createLesson,
  createSection,
  publishCourse,
  publishLesson,
} from "../src/features/courses/service";
import { enrollFree } from "../src/features/enrollments/service";
import {
  countMyCourseNotes,
  deleteMyLessonNote,
  getMyLessonNote,
  listMyCourseNotes,
  saveMyLessonNote,
} from "../src/features/notes/service";
import {
  noteBodySchema,
  NOTE_MAX_BODY,
  normalizeNoteBody,
} from "../src/features/notes/types";

const nodeRequire = createRequire(__filename);
const uid = () => crypto.randomUUID().slice(0, 10);
let cookieHeader = "";
let learnerA = "";
let learnerB = "";
let actions: typeof import("../src/features/notes/actions");

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

async function account(): Promise<{ id: string; cookie: string }> {
  const auth = await getAuth();
  const email = `notes-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({ body: { email, password, name: "Notes Learner" } });
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  return {
    id: created.user.id,
    cookie: signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
  };
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers({ cookie: cookieHeader }) });
  stubModule("next/cache", { revalidatePath: () => {} });
  const a = await account();
  const b = await account();
  learnerA = a.id;
  learnerB = b.id;
  cookieHeader = a.cookie;
  actions = await import("../src/features/notes/actions");
});

test.after(async () => {
  await disposeCloudflareBindings();
});

async function makeCourse(options: { preview?: boolean; lessonCount?: number } = {}) {
  const course = await createCourse({
    title: "Notes course",
    slug: `notes-course-${uid()}`,
  });
  const section = await createSection({ courseId: course.id, title: "Notes section" });
  const created: Lesson[] = [];
  const count = options.lessonCount ?? 1;
  for (let index = 0; index < count; index += 1) {
    const lesson = await createLesson({
      courseId: course.id,
      sectionId: section.id,
      title: `Notes lesson ${index + 1}`,
      slug: `notes-lesson-${uid()}`,
      required: true,
      isPreview: options.preview ?? false,
    });
    await publishLesson(lesson.id);
    created.push(lesson);
  }
  await publishCourse(course.id);
  return { course, section, lessons: created, lesson: created[0] };
}

async function noteRows(userId: string, lessonId: string) {
  const db = await getDb();
  return db
    .select()
    .from(lessonNotes)
    .where(and(eq(lessonNotes.userId, userId), eq(lessonNotes.lessonId, lessonId)));
}

/** Move a saved note's timestamp into the past so the 1 s throttle passes. */
async function ageNote(userId: string, lessonId: string) {
  const db = await getDb();
  await db
    .update(lessonNotes)
    .set({ updatedAt: new Date(Date.now() - 2_000) })
    .where(and(eq(lessonNotes.userId, userId), eq(lessonNotes.lessonId, lessonId)));
}

// ---------------------------------------------------------------- schema

test("note body schema normalises NFC, trims, caps and rejects control characters", () => {
  assert.equal(normalizeNoteBody("  hello  "), "hello");
  assert.equal(noteBodySchema.parse("  hello  "), "hello");
  assert.equal(noteBodySchema.parse("e\u0301"), "\u00e9", "combining input is NFC-normalised");
  assert.equal(noteBodySchema.parse("line one\nline two\ttabbed"), "line one\nline two\ttabbed");

  assert.equal(noteBodySchema.safeParse("x".repeat(NOTE_MAX_BODY)).success, true);
  assert.equal(noteBodySchema.safeParse("x".repeat(NOTE_MAX_BODY + 1)).success, false);

  assert.equal(noteBodySchema.safeParse("a\u0001b").success, false, "control chars are rejected");
  assert.equal(noteBodySchema.safeParse("a\rb").success, false, "carriage returns are rejected");
  assert.equal(noteBodySchema.safeParse("a\u007Fb").success, false, "DEL is rejected");
  assert.equal(noteBodySchema.safeParse("   ").success, true, "whitespace-only is a valid empty body");
});

// ---------------------------------------------------------------- authorization

test("save authorization matrix: signed out, unenrolled, preview, cancelled, enrolled, other course", async () => {
  const { course, lesson } = await makeCourse();

  cookieHeader = "";
  const signedOut = await actions.saveLessonNoteAction({
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "Signed out",
  });
  assert.equal(signedOut.ok, false, "signed-out saves are refused");
  assert.match(signedOut.error ?? "", /Unauthorized/i);

  await assert.rejects(
    () => saveMyLessonNote(learnerA, { courseSlug: course.slug, lessonSlug: lesson.slug, body: "No enrollment" }),
    /Enroll in this course/,
    "unenrolled learners are refused",
  );

  const preview = await makeCourse({ preview: true });
  await assert.rejects(
    () => saveMyLessonNote(learnerA, {
      courseSlug: preview.course.slug,
      lessonSlug: preview.lesson.slug,
      body: "Preview only",
    }),
    /Enroll in this course/,
    "preview-only readers are refused",
  );

  const cancelledFixture = await makeCourse();
  const cancelledEnrollment = await enrollFree(learnerA, cancelledFixture.course.id);
  await saveMyLessonNote(learnerA, {
    courseSlug: cancelledFixture.course.slug,
    lessonSlug: cancelledFixture.lesson.slug,
    body: "Keep me",
  });
  await (await getDb())
    .update(enrollments)
    .set({ status: "cancelled" })
    .where(eq(enrollments.id, cancelledEnrollment.id));
  await assert.rejects(
    () => saveMyLessonNote(learnerA, {
      courseSlug: cancelledFixture.course.slug,
      lessonSlug: cancelledFixture.lesson.slug,
      body: "Cancelled",
    }),
    /Enroll in this course/,
    "cancelled enrollments are refused",
  );

  await enrollFree(learnerA, course.id);
  const saved = await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "Enrolled note",
  });
  assert.equal(saved.deleted, false);
  assert.ok(saved.updatedAt instanceof Date);
  const read = await getMyLessonNote(learnerA, lesson.id);
  assert.equal(read?.body, "Enrolled note");

  const other = await makeCourse();
  await assert.rejects(
    () => saveMyLessonNote(learnerA, {
      courseSlug: course.slug,
      lessonSlug: other.lesson.slug,
      body: "Wrong course",
    }),
    /Lesson not found/,
    "a lesson from another course cannot be saved through this course slug",
  );
});

// ---------------------------------------------------------------- owner isolation

test("owner isolation: another enrolled learner cannot read, overwrite or delete a note", async () => {
  const { course, lesson } = await makeCourse();
  await enrollFree(learnerA, course.id);
  await enrollFree(learnerB, course.id);

  await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "A private",
  });

  assert.equal(await getMyLessonNote(learnerB, lesson.id), null, "B cannot read A's note");

  await saveMyLessonNote(learnerB, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "B private",
  });

  assert.equal((await getMyLessonNote(learnerA, lesson.id))?.body, "A private");
  assert.equal((await getMyLessonNote(learnerB, lesson.id))?.body, "B private");
  assert.equal((await noteRows(learnerA, lesson.id)).length, 1);
  assert.equal((await noteRows(learnerB, lesson.id)).length, 1);

  const deleted = await deleteMyLessonNote(learnerB, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
  });
  assert.equal(deleted.deleted, true);
  assert.equal((await noteRows(learnerB, lesson.id)).length, 0);
  assert.equal((await noteRows(learnerA, lesson.id))[0]?.body, "A private", "A's note survives");
});

// ---------------------------------------------------------------- upsert + empty

test("saving upserts one row per user and lesson; an empty body deletes it", async () => {
  const { course, lesson } = await makeCourse();
  await enrollFree(learnerA, course.id);

  await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "First draft",
  });
  await ageNote(learnerA, lesson.id);
  await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "Second draft",
  });

  const rows = await noteRows(learnerA, lesson.id);
  assert.equal(rows.length, 1, "one row per (user, lesson)");
  assert.equal(rows[0].body, "Second draft");

  await ageNote(learnerA, lesson.id);
  const cleared = await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "   ",
  });
  assert.equal(cleared.deleted, true);
  assert.equal(cleared.updatedAt, null);
  assert.equal((await noteRows(learnerA, lesson.id)).length, 0, "empty saves delete the note");
  assert.equal(await getMyLessonNote(learnerA, lesson.id), null);
});

// ---------------------------------------------------------------- throttle

test("saves within 1 s are rejected softly; later saves are allowed", async () => {
  const { course, lesson } = await makeCourse();
  await enrollFree(learnerA, course.id);

  await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "One",
  });
  await assert.rejects(
    () => saveMyLessonNote(learnerA, {
      courseSlug: course.slug,
      lessonSlug: lesson.slug,
      body: "Two",
    }),
    /Saving too fast/,
  );

  await ageNote(learnerA, lesson.id);
  const later = await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "Two",
  });
  assert.equal(later.deleted, false);
  assert.equal((await getMyLessonNote(learnerA, lesson.id))?.body, "Two");
});

// ---------------------------------------------------------------- list

test("listMyCourseNotes follows curriculum order and scopes to the user and course", async () => {
  const first = await makeCourse({ lessonCount: 2 });
  await enrollFree(learnerA, first.course.id);
  await enrollFree(learnerB, first.course.id);

  // Save out of curriculum order; order must still follow the lessons.
  await saveMyLessonNote(learnerA, {
    courseSlug: first.course.slug,
    lessonSlug: first.lessons[1].slug,
    body: "Second lesson note",
  });
  await saveMyLessonNote(learnerA, {
    courseSlug: first.course.slug,
    lessonSlug: first.lessons[0].slug,
    body: "First lesson note",
  });
  await saveMyLessonNote(learnerB, {
    courseSlug: first.course.slug,
    lessonSlug: first.lessons[0].slug,
    body: "B note",
  });

  const other = await makeCourse();
  await enrollFree(learnerA, other.course.id);
  await saveMyLessonNote(learnerA, {
    courseSlug: other.course.slug,
    lessonSlug: other.lesson.slug,
    body: "Other course note",
  });

  const list = await listMyCourseNotes(learnerA, first.course.id);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((entry) => entry.lessonId), [
    first.lessons[0].id,
    first.lessons[1].id,
  ]);
  assert.equal(list[0].lessonTitle, first.lessons[0].title);
  assert.equal(list[0].body, "First lesson note");
  assert.equal(list[1].body, "Second lesson note");
  assert.ok(!list.some((entry) => entry.body === "B note"), "another learner's note is excluded");

  const otherList = await listMyCourseNotes(learnerA, other.course.id);
  assert.equal(otherList.length, 1);
  assert.equal(otherList[0].body, "Other course note");

  assert.equal(await countMyCourseNotes(learnerA, first.course.id), 2);
  assert.equal(await countMyCourseNotes(learnerB, first.course.id), 1);
  assert.deepEqual(await listMyCourseNotes(learnerB, other.course.id), []);
});

// ---------------------------------------------------------------- cancelled

test("a cancelled enrollment keeps the rows but its reads are refused", async () => {
  const { course, lesson } = await makeCourse();
  const enrollment = await enrollFree(learnerA, course.id);
  await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "Survives cancellation",
  });

  await (await getDb())
    .update(enrollments)
    .set({ status: "cancelled" })
    .where(eq(enrollments.id, enrollment.id));

  assert.equal((await noteRows(learnerA, lesson.id)).length, 1, "the row stays in D1");
  assert.equal(await getMyLessonNote(learnerA, lesson.id), null, "reads are refused");
  assert.deepEqual(await listMyCourseNotes(learnerA, course.id), [], "the notes list is empty");
  await assert.rejects(
    () => deleteMyLessonNote(learnerA, { courseSlug: course.slug, lessonSlug: lesson.slug }),
    /Enroll in this course/,
    "writes are refused while cancelled",
  );

  await enrollFree(learnerA, course.id);
  assert.equal((await getMyLessonNote(learnerA, lesson.id))?.body, "Survives cancellation");
});

// ---------------------------------------------------------------- cascade

test("deleting the lesson removes its notes", async () => {
  const { course, lesson } = await makeCourse();
  await enrollFree(learnerA, course.id);
  await saveMyLessonNote(learnerA, {
    courseSlug: course.slug,
    lessonSlug: lesson.slug,
    body: "Cascade me",
  });
  assert.equal((await noteRows(learnerA, lesson.id)).length, 1);

  await (await getDb()).delete(lessons).where(eq(lessons.id, lesson.id));
  assert.equal((await noteRows(learnerA, lesson.id)).length, 0);
});
