/**
 * SECURITY QUICK-FIX REGRESSIONS
 * ---------------------------------------------------------------------------
 * - REDIRECT: post-auth ?redirect= values must stay same-origin, including
 *   the `/\evil.com` and control-character bypasses.
 * - ERRORS: only AppError messages reach callers; internal errors are
 *   replaced by the fallback and mapped to HTTP 500.
 * - RACE: enrollment reconcile writes are conditional on the status they
 *   replace, so a cancellation landing between read and write survives.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import {
  getDb,
  users,
  courses,
  courseSections,
  lessons,
  enrollments,
  lessonProgress,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import {
  disposeCloudflareBindings,
  getD1Database,
  setD1DatabaseForTest,
  clearD1DatabaseForTest,
} from "../src/lib/cloudflare/bindings";
import { safeRedirectPath } from "../src/lib/safe-redirect";
import { AppError, httpStatusFor, isAppError, publicErrorMessage } from "../src/lib/errors";
import { requireAdmin, requireUser } from "../src/lib/auth";
import { createCourseAction } from "../src/features/courses/actions";
import {
  createCourse,
  createSection,
  createLesson,
  publishLesson,
  publishCourse,
} from "../src/features/courses/service";
import { enrollFree, getEnrollment } from "../src/features/enrollments/service";
import {
  reconcileCourseEnrollments,
  reconcileEnrollmentCompletion,
} from "../src/features/progress/service";
import { toActionResult, unwrapActionResult } from "../src/lib/action-result";
import { approveAction } from "../src/features/editorial-ai/drafts/actions";
import { deleteKnowledgeAction } from "../src/features/editorial-ai/knowledge/actions";
import { archiveMemoryAction } from "../src/features/editorial-ai/memory/actions";
import { approve } from "../src/features/editorial-ai/drafts/service";
import { ingestKnowledgeSource } from "../src/features/editorial-ai/knowledge/service";
import { POST as knowledgeUploadPOST } from "../src/app/api/editorial-ai/knowledge/upload/route";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { D1Database } from "@cloudflare/workers-types";

test.before(async () => {
  await migrateLocalDb();
});

test.after(async () => {
  await disposeCloudflareBindings();
});

const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

// ---------------------------------------------------------------- redirect

test("REDIRECT: same-origin paths pass through unchanged", () => {
  assert.equal(safeRedirectPath("/learn"), "/learn");
  assert.equal(safeRedirectPath("/learn/courses/a?tab=1#x"), "/learn/courses/a?tab=1#x");
});

test("REDIRECT: off-site and malformed values fall back", () => {
  const hostile = [
    "//evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "learn",
    "",
    null,
    undefined,
  ];
  for (const value of hostile) {
    assert.equal(safeRedirectPath(value), "/learn", `expected fallback for ${JSON.stringify(value)}`);
  }
  assert.equal(safeRedirectPath("//evil.com", "/home"), "/home");
});

// ---------------------------------------------------------------- errors

test("ERRORS: AppError messages are public with kind-mapped status", () => {
  const conflict = new AppError("conflict", "A course with the slug \"x\" already exists.");
  assert.equal(publicErrorMessage(conflict, "Failed"), conflict.message);
  assert.equal(httpStatusFor(conflict), 409);
  assert.equal(httpStatusFor(new AppError("unauthorized", "u")), 401);
  assert.equal(httpStatusFor(new AppError("forbidden", "f")), 403);
  assert.equal(httpStatusFor(new AppError("not_found", "n")), 404);
  assert.equal(httpStatusFor(new AppError("invalid", "i")), 400);
});

test("ERRORS: internal errors are masked and map to 500", (t) => {
  t.mock.method(console, "error", () => {});
  const driverError = new Error("Failed query: insert into \"courses\" ... SQLITE_BUSY");
  assert.equal(publicErrorMessage(driverError, "Failed to create course"), "Failed to create course");
  assert.equal(publicErrorMessage("boom", "Fallback"), "Fallback");
  assert.equal(httpStatusFor(driverError), 500);
});

test("ERRORS: auth guards throw typed AppErrors", async () => {
  await assert.rejects(() => requireAdmin(), (err: unknown) => isAppError(err) && err.kind === "unauthorized");
  await assert.rejects(() => requireUser(), (err: unknown) => isAppError(err) && err.kind === "unauthorized");
});

test("ERRORS: server actions still surface AppError text", async () => {
  const res = await createCourseAction({ title: "Anon attempt" });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /Unauthorized/);
});

test("ERRORS: toActionResult keeps AppError/Zod messages and masks the rest", async (t) => {
  t.mock.method(console, "error", () => {});
  assert.deepEqual(await toActionResult(async () => 42, "Fallback"), { ok: true, data: 42 });
  assert.deepEqual(
    await toActionResult(async () => {
      throw new AppError("conflict", "Draft changed. Retry.");
    }, "Fallback"),
    { ok: false, error: "Draft changed. Retry." }
  );
  assert.deepEqual(
    await toActionResult(async () => z.object({ title: z.string().min(3, "Title too short") }).parse({ title: "x" }), "Fallback"),
    { ok: false, error: "Title too short" }
  );
  assert.deepEqual(
    await toActionResult(async () => {
      throw new Error("LLM request failed: 500. Body: {\"secret\":\"sk-...\"}");
    }, "Failed to generate draft"),
    { ok: false, error: "Failed to generate draft" }
  );
  assert.throws(() => unwrapActionResult({ ok: false, error: "Nope" }), /^Error: Nope$/);
  assert.equal(unwrapActionResult({ ok: true, data: "x" }), "x");
});

test("ERRORS: editorial-AI actions return results instead of throwing", async () => {
  const results = await Promise.all([
    approveAction("missing"),
    deleteKnowledgeAction("missing"),
    archiveMemoryAction("missing"),
  ]);
  for (const res of results) {
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /Unauthorized/);
  }
});

test("ERRORS: editorial-AI services throw typed AppErrors for user-facing failures", async () => {
  await assert.rejects(() => approve("draft_missing", "actor"), (err: unknown) => isAppError(err) && err.kind === "not_found");
  await assert.rejects(
    () => ingestKnowledgeSource("source_missing", "actor"),
    (err: unknown) => isAppError(err) && err.kind === "not_found"
  );
});

test("ERRORS: anonymous knowledge upload is 401 with a safe message", async () => {
  const form = new FormData();
  form.append("file", new Blob(["hello"], { type: "text/plain" }), "note.txt");
  const res = await knowledgeUploadPOST(
    new Request("http://localhost/api/editorial-ai/knowledge/upload", { method: "POST", body: form })
  );
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /Unauthorized/);
});

// ---------------------------------------------------------------- race

async function makeCompletedButActiveEnrollment() {
  const db = await getDb();
  const slug = `sqf-race-${stamp()}`;
  const course = await createCourse({ title: "Race Course", slug, accessMode: "FREE" });
  const section = await createSection({ courseId: course.id, title: "S1" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Only Lesson",
    slug: `only-${stamp()}`,
    required: true,
  });
  await publishLesson(lesson.id);
  await publishCourse(course.id);

  const userId = `u_test_${stamp()}`;
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    name: "Race Learner",
    email: `sqf-race-${stamp()}@example.com`,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
    role: "user",
  });
  const enrollment = await enrollFree(userId, course.id);
  // Progress row written directly so the enrollment is still "active" while
  // the required set is already satisfied: the next reconcile wants to close it.
  await db.insert(lessonProgress).values({
    id: `prog_${stamp()}`,
    enrollmentId: enrollment.id,
    lessonId: lesson.id,
    completedAt: now,
  });

  const cleanup = async () => {
    await db.delete(lessonProgress).where(eq(lessonProgress.enrollmentId, enrollment.id));
    await db.delete(enrollments).where(eq(enrollments.courseId, course.id));
    await db.delete(lessons).where(eq(lessons.courseId, course.id));
    await db.delete(courseSections).where(eq(courseSections.courseId, course.id));
    await db.delete(courses).where(eq(courses.id, course.id));
    await db.delete(users).where(eq(users.id, userId));
  };
  return { enrollment, userId, courseId: course.id, cleanup };
}

/** D1 whose first enrollments UPDATE is preceded by a concurrent cancel. */
async function installCancelBeforeUpdate(enrollmentId: string) {
  const realD1 = await getD1Database();
  let fired = false;
  const fakeDb = {
    prepare: (sql: string) => {
      if (!fired && /update\s+["'`]?enrollments/i.test(sql)) {
        fired = true;
        const stmt = realD1.prepare(sql);
        const cancelFirst = () =>
          realD1
            .prepare("UPDATE enrollments SET status = 'cancelled', completed_at = NULL WHERE id = ?")
            .bind(enrollmentId)
            .run();
        return {
          bind: (...values: unknown[]) => {
            const bound = stmt.bind(...values);
            return {
              ...bound,
              run: async () => {
                await cancelFirst();
                return bound.run();
              },
              all: async () => {
                await cancelFirst();
                return bound.all();
              },
            };
          },
        };
      }
      return realD1.prepare(sql);
    },
    batch: realD1.batch.bind(realD1),
  } as unknown as D1Database;
  setD1DatabaseForTest(fakeDb);
  return () => fired;
}

test("RACE: reconcile never overwrites a concurrent cancellation", async () => {
  const { enrollment, userId, courseId, cleanup } = await makeCompletedButActiveEnrollment();
  const updateIntercepted = await installCancelBeforeUpdate(enrollment.id);
  try {
    await reconcileEnrollmentCompletion(enrollment, true);
  } finally {
    clearD1DatabaseForTest();
  }
  try {
    assert.equal(updateIntercepted(), true, "the reconcile UPDATE must have run");
    const row = await getEnrollment(userId, courseId);
    assert.equal(row?.status, "cancelled");
    assert.equal(row?.completedAt, null);
  } finally {
    await cleanup();
  }
});

test("RACE: course-wide reconcile never overwrites a concurrent cancellation", async () => {
  const { enrollment, userId, courseId, cleanup } = await makeCompletedButActiveEnrollment();
  const updateIntercepted = await installCancelBeforeUpdate(enrollment.id);
  try {
    await reconcileCourseEnrollments(courseId);
  } finally {
    clearD1DatabaseForTest();
  }
  try {
    assert.equal(updateIntercepted(), true, "the course-wide reconcile UPDATE must have run");
    const row = await getEnrollment(userId, courseId);
    assert.equal(row?.status, "cancelled");
    assert.equal(row?.completedAt, null);
  } finally {
    await cleanup();
  }
});
