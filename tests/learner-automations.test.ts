/**
 * LEARNER AUTOMATIONS TESTS (Batch J)
 * ---------------------------------------------------------------------------
 * - each rule fires once and dedupes on rerun (unlock, completed, inactive,
 *   quiz-failed);
 * - rules respect their course toggles (all OFF by default), skip cancelled
 *   enrollments and opted-out learners, and enqueue nothing while email is off;
 * - the per-run limit is respected; new outbox kinds expire in 48 h;
 * - unsubscribe token: valid, tampered, other-user; GET has no side effect;
 *   POST is idempotent;
 * - cron route: 404 without the token (GET or wrong token), 200 with it;
 * - the hourly scheduled() gate is unit-tested as a pure function.
 *
 * Runs through tsx via `npm test` (no Playwright).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import "./helpers/env"; // MUST be first: fake TEST-ONLY secret before any app module.

import { eq } from "drizzle-orm";
import {
  emailOutbox,
  enrollments,
  getDb,
  lessonQuizzes,
  lessons,
  quizAttempts,
  type EmailOutboxRow,
} from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import { expiryForKind } from "../src/lib/email/outbox";
import { getDrainToken } from "../src/lib/email/drain-token";
import {
  getCourseNudgesOptIn,
  setCourseNudgesOptIn,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../src/lib/email/preferences";
import {
  runLearnerAutomations,
  shouldRunLearnerAutomations,
} from "../src/features/automations/service";
import {
  createCourse,
  createLesson,
  createSection,
  publishCourse,
  publishLesson,
} from "../src/features/courses/service";
import { enrollFree } from "../src/features/enrollments/service";
import { markLessonComplete } from "../src/features/progress/service";
import { upsertLessonQuiz } from "../src/features/quizzes/service";

const nodeRequire = createRequire(__filename);
const uid = () => crypto.randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;

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

function enableEmail(): void {
  process.env.SMTP_USERNAME = "automations-user@example.test";
  process.env.SMTP_PASSWORD = "automations-test-sentinel-pw-9";
  process.env.MAIL_FROM_ADDRESS = "noreply@example.com";
}

function disableEmail(): void {
  delete process.env.SMTP_USERNAME;
  delete process.env.SMTP_PASSWORD;
  delete process.env.MAIL_FROM_ADDRESS;
}

async function account(name: string): Promise<{ id: string; email: string }> {
  const auth = await getAuth();
  const email = `automations-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({ body: { email, password, name } });
  return { id: created.user.id, email };
}

async function clearOutbox(): Promise<void> {
  await (await getDb()).delete(emailOutbox).run();
}

async function outboxRows(): Promise<EmailOutboxRow[]> {
  return (await getDb()).select().from(emailOutbox);
}

async function backdateEnrollment(enrollmentId: string, enrolledAt: Date): Promise<void> {
  await (await getDb()).update(enrollments).set({ enrolledAt }).where(eq(enrollments.id, enrollmentId));
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers() });
  stubModule("next/cache", { revalidatePath: () => {} });
  enableEmail();
});

test.after(async () => {
  disableEmail();
  await disposeCloudflareBindings();
});

async function makeToggledCourse(toggles: {
  notifyUnlocks?: boolean;
  nudgeCompleted?: boolean;
  nudgeInactive?: boolean;
  nudgeQuizFailed?: boolean;
  coachingPath?: string | null;
}) {
  const course = await createCourse({
    title: "Automation course",
    slug: `auto-course-${uid()}`,
    ...toggles,
  });
  const section = await createSection({ courseId: course.id, title: "Auto section" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Auto lesson",
    slug: `auto-lesson-${uid()}`,
    required: true,
  });
  await publishLesson(lesson.id);
  await publishCourse(course.id);
  return { course, section, lesson };
}

function quizFixture(lessonId: string) {
  return {
    lessonId,
    passPercent: 70,
    requirePass: false,
    questions: [
      {
        id: "q1",
        prompt: "Prompt",
        kind: "single" as const,
        options: [
          { id: "o1", text: "One" },
          { id: "o2", text: "Two" },
        ],
        correctOptionIds: ["o1"],
      },
    ],
  };
}

// ---------------------------------------------------------------- unlock

test("lesson_unlocked fires once per enrollment+lesson and dedupes on rerun", async () => {
  await clearOutbox();
  const { course, lesson } = await makeToggledCourse({ notifyUnlocks: true });
  const learner = await account("Unlock Learner");
  const enrollment = await enrollFree(learner.id, course.id);
  await backdateEnrollment(enrollment.id, new Date(Date.now() - 25 * 3_600_000));
  // Drip of 1 day elapsed 25 h ago: inside the (now − 26 h, now] window.
  await (await getDb()).update(lessons).set({ releaseMode: "drip", dripDays: 1 }).where(eq(lessons.id, lesson.id));

  const first = await runLearnerAutomations({ now: new Date() });
  assert.equal(first.unlocked, 1);
  assert.equal(first.enqueued, 1);

  const second = await runLearnerAutomations({ now: new Date() });
  assert.deepEqual(second, { unlocked: 0, completed: 0, inactive: 0, quizFailed: 0, enqueued: 0 });

  const rows = await outboxRows();
  const mine = rows.find((r) => r.dedupeKey === `unlock:${enrollment.id}:${lesson.id}`);
  assert.ok(mine);
  assert.equal(mine.kind, "lesson_unlocked");
  assert.ok(mine.textBody.includes("Unsubscribe from course reminders"));
});

test("unlock respects toggles, cancelled enrollments and opt-outs", async () => {
  // No outbox reset here: earlier unlock rows stay queued, so reruns dedupe
  // and only genuinely new candidates may fire.
  const plain = await makeToggledCourse({});
  const learner = await account("Quiet Learner");
  const enrollment = await enrollFree(learner.id, plain.course.id);
  await backdateEnrollment(enrollment.id, new Date(Date.now() - 25 * 3_600_000));
  await (await getDb()).update(lessons).set({ releaseMode: "drip", dripDays: 1 }).where(eq(lessons.id, plain.lesson.id));
  const off = await runLearnerAutomations({ now: new Date() });
  assert.equal(off.enqueued, 0);

  // Toggle ON but cancelled: still nothing.
  const toggled = await makeToggledCourse({ notifyUnlocks: true });
  await (await getDb()).update(lessons).set({ releaseMode: "drip", dripDays: 1 }).where(eq(lessons.id, toggled.lesson.id));
  const cancelled = await enrollFree(learner.id, toggled.course.id);
  await backdateEnrollment(cancelled.id, new Date(Date.now() - 25 * 3_600_000));
  const { cancelMyEnrollment } = await import("../src/features/enrollments/service");
  await cancelMyEnrollment(learner.id, toggled.course.id);
  const afterCancel = await runLearnerAutomations({ now: new Date() });
  assert.equal(afterCancel.unlocked, 0);

  // Toggle ON, active, but opted out: nothing.
  const active = await account("Optout Learner");
  const activeEnrollment = await enrollFree(active.id, toggled.course.id);
  await backdateEnrollment(activeEnrollment.id, new Date(Date.now() - 25 * 3_600_000));
  await setCourseNudgesOptIn(active.id, false);
  const afterOptOut = await runLearnerAutomations({ now: new Date() });
  assert.equal(afterOptOut.enqueued, 0);
  const keys = new Set((await outboxRows()).map((r) => r.dedupeKey));
  assert.ok(!keys.has(`unlock:${cancelled.id}:${toggled.lesson.id}`));
  assert.ok(!keys.has(`unlock:${activeEnrollment.id}:${toggled.lesson.id}`));
});

// ---------------------------------------------------------------- completed

test("nudge_completed fires for recent completions and dedupes", async () => {
  const { course, lesson } = await makeToggledCourse({ nudgeCompleted: true, coachingPath: "/coaching" });
  const learner = await account("Done Learner");
  const enrollment = await enrollFree(learner.id, course.id);
  await markLessonComplete(learner.id, enrollment.id, lesson.id);

  const first = await runLearnerAutomations({ now: new Date() });
  assert.equal(first.completed, 1);
  const rows = await outboxRows();
  const mine = rows.find((r) => r.kind === "nudge_completed");
  assert.ok(mine);
  assert.equal(mine.dedupeKey, `nudge_completed:${enrollment.id}`);
  assert.ok(mine.textBody.includes("/coaching"));

  const second = await runLearnerAutomations({ now: new Date() });
  assert.equal(second.enqueued, 0);
});

// ---------------------------------------------------------------- inactive

test("nudge_inactive fires for 7–8 day idle learners only", async () => {
  const { course } = await makeToggledCourse({ nudgeInactive: true });
  const idle = await account("Idle Learner");
  const idleEnrollment = await enrollFree(idle.id, course.id);
  await backdateEnrollment(idleEnrollment.id, new Date(Date.now() - 7.5 * DAY_MS));
  const fresh = await account("Fresh Learner");
  await enrollFree(fresh.id, course.id);

  const result = await runLearnerAutomations({ now: new Date() });
  assert.equal(result.inactive, 1);
  const rows = await outboxRows();
  const mine = rows.find((r) => r.kind === "nudge_inactive");
  assert.ok(mine);
  assert.ok(mine.dedupeKey?.startsWith(`nudge_inactive:${idleEnrollment.id}:`));
});

// ---------------------------------------------------------------- quiz-failed

async function insertAttempt(input: {
  quizId: string;
  userId: string;
  enrollmentId: string;
  lessonId: string;
  passed: boolean;
  at: Date;
}) {
  await (await getDb()).insert(quizAttempts).values({
    id: `att_${uid()}`,
    quizId: input.quizId,
    userId: input.userId,
    enrollmentId: input.enrollmentId,
    lessonId: input.lessonId,
    answers: "{}",
    scorePercent: input.passed ? 100 : 0,
    correctCount: input.passed ? 1 : 0,
    totalCount: 1,
    passed: input.passed,
    createdAt: input.at,
  });
}

test("nudge_quiz_failed needs two failures, no pass, and a recent failure", async () => {
  const { course, lesson } = await makeToggledCourse({ nudgeQuizFailed: true });
  const quiz = await upsertLessonQuiz(quizFixture(lesson.id));
  const quizRow = (await (await getDb()).select().from(lessonQuizzes)).find((q) => q.lessonId === lesson.id)!;
  void quiz;

  const struggler = await account("Struggler");
  const strugglerEnrollment = await enrollFree(struggler.id, course.id);
  await insertAttempt({
    quizId: quizRow.id, userId: struggler.id, enrollmentId: strugglerEnrollment.id,
    lessonId: lesson.id, passed: false, at: new Date(Date.now() - 30 * 3_600_000),
  });
  await insertAttempt({
    quizId: quizRow.id, userId: struggler.id, enrollmentId: strugglerEnrollment.id,
    lessonId: lesson.id, passed: false, at: new Date(Date.now() - 2 * 3_600_000),
  });

  // One failure only: no email.
  const single = await account("Single Fail");
  const singleEnrollment = await enrollFree(single.id, course.id);
  await insertAttempt({
    quizId: quizRow.id, userId: single.id, enrollmentId: singleEnrollment.id,
    lessonId: lesson.id, passed: false, at: new Date(Date.now() - 2 * 3_600_000),
  });

  // Two failures but a pass exists: no email.
  const passer = await account("Passer");
  const passerEnrollment = await enrollFree(passer.id, course.id);
  await insertAttempt({
    quizId: quizRow.id, userId: passer.id, enrollmentId: passerEnrollment.id,
    lessonId: lesson.id, passed: false, at: new Date(Date.now() - 30 * 3_600_000),
  });
  await insertAttempt({
    quizId: quizRow.id, userId: passer.id, enrollmentId: passerEnrollment.id,
    lessonId: lesson.id, passed: true, at: new Date(Date.now() - 2 * 3_600_000),
  });

  const result = await runLearnerAutomations({ now: new Date() });
  assert.equal(result.quizFailed, 1);
  const rows = await outboxRows();
  const mine = rows.find((r) => r.dedupeKey === `nudge_quiz_failed:${struggler.id}:${quizRow.id}`);
  assert.ok(mine);
  assert.equal(mine.kind, "nudge_quiz_failed");
});

// ---------------------------------------------------------------- limits + email-off + expiry

test("per-run limit is respected and email-off enqueues nothing", async () => {
  await clearOutbox();
  const { course, lesson } = await makeToggledCourse({ notifyUnlocks: true });
  const db = await getDb();
  await db.update(lessons).set({ releaseMode: "drip", dripDays: 1 }).where(eq(lessons.id, lesson.id));
  for (let i = 0; i < 3; i += 1) {
    const learner = await account(`Limit ${i}`);
    const enrollment = await enrollFree(learner.id, course.id);
    await backdateEnrollment(enrollment.id, new Date(Date.now() - 25 * 3_600_000));
  }
  const limited = await runLearnerAutomations({ now: new Date(), limit: 1 });
  assert.equal(limited.enqueued, 1);

  disableEmail();
  try {
    const off = await runLearnerAutomations({ now: new Date() });
    assert.deepEqual(off, { unlocked: 0, completed: 0, inactive: 0, quizFailed: 0, enqueued: 0 });
    assert.equal((await outboxRows()).filter((r) => r.kind === "lesson_unlocked").length, 1);
  } finally {
    enableEmail();
  }
});

test("new kinds expire in 48 h", async () => {
  const now = new Date("2026-03-01T00:00:00.000Z");
  const expected = now.getTime() + 48 * 3_600_000;
  for (const kind of ["lesson_unlocked", "nudge_completed", "nudge_inactive", "nudge_quiz_failed"] as const) {
    assert.equal(expiryForKind(kind, now).getTime(), expected, kind);
  }
});

// ---------------------------------------------------------------- unsubscribe

test("unsubscribe token verifies the right user only", async () => {
  const learner = await account("Token Learner");
  const token = await signUnsubscribeToken(learner.id);
  assert.equal(await verifyUnsubscribeToken(learner.id, token), true);
  assert.equal(await verifyUnsubscribeToken(learner.id, `${token}x`), false);
  assert.equal(await verifyUnsubscribeToken("someone-else", token), false);
  assert.equal(await verifyUnsubscribeToken(learner.id, "not-hex"), false);
});

test("unsubscribe GET has no side effect; POST is idempotent", async () => {
  const route = await import("../src/app/email/unsubscribe/route");
  const learner = await account("Unsub Learner");
  assert.equal(await getCourseNudgesOptIn(learner.id), true);
  const token = await signUnsubscribeToken(learner.id);

  const getRes = await route.GET(new Request(`http://x/email/unsubscribe?u=${learner.id}&t=${token}`));
  assert.equal(getRes.status, 200);
  assert.match(getRes.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(await getCourseNudgesOptIn(learner.id), true);

  const post = () =>
    route.POST(
      new Request("http://x/email/unsubscribe", {
        method: "POST",
        body: new URLSearchParams({ u: learner.id, t: token }),
      }),
    );
  const first = await post();
  assert.equal(first.status, 200);
  assert.match(await first.text(), /Unsubscribed/);
  assert.equal(await getCourseNudgesOptIn(learner.id), false);
  const second = await post();
  assert.equal(second.status, 200);
  assert.equal(await getCourseNudgesOptIn(learner.id), false);

  const bad = await route.POST(
    new Request("http://x/email/unsubscribe", {
      method: "POST",
      body: new URLSearchParams({ u: learner.id, t: "tampered" }),
    }),
  );
  assert.equal(bad.status, 200);
  assert.match(await bad.text(), /not recognized/);
});

// ---------------------------------------------------------------- cron + gate

test("cron route 404s without the token and runs with it", async () => {
  const route = await import("../src/app/api/cron/learner-automations/route");
  assert.equal((await route.GET()).status, 404);
  assert.equal(
    (await route.POST(new Request("http://x/api/cron/learner-automations", { method: "POST" }))).status,
    404,
  );
  assert.equal(
    (
      await route.POST(
        new Request("http://x/api/cron/learner-automations", {
          method: "POST",
          headers: { "x-email-drain-token": "wrong" },
        }),
      )
    ).status,
    404,
  );
  disableEmail();
  try {
    const ok = await route.POST(
      new Request("http://x/api/cron/learner-automations", {
        method: "POST",
        headers: { "x-email-drain-token": getDrainToken() },
      }),
    );
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("cache-control") ?? "", /no-store/);
  } finally {
    enableEmail();
  }
});

test("hourly gate runs only when the scheduled minute is below 5", async () => {
  assert.equal(shouldRunLearnerAutomations(new Date("2026-01-01T00:00:00.000Z")), true);
  assert.equal(shouldRunLearnerAutomations(new Date("2026-01-01T00:04:59.000Z")), true);
  assert.equal(shouldRunLearnerAutomations(new Date("2026-01-01T00:05:00.000Z")), false);
  assert.equal(shouldRunLearnerAutomations(new Date("2026-01-01T00:30:00.000Z")), false);
});
