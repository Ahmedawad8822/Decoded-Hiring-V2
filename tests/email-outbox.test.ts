/**
 * TRANSACTIONAL EMAIL OUTBOX TESTS (Batch G)
 * ---------------------------------------------------------------------------
 * - disabled config → rows stay pending, nothing sent;
 * - success → sent, bodies cleared;
 * - 4xx → retry with backoff, then failed after 5 attempts;
 * - 5xx and validation errors → failed at once; a rejected AUTH pauses the drain;
 * - expired rows → expired, never sent;
 * - two concurrent drains send a row only once;
 * - expired leases are reclaimed;
 * - 300/hour cap stops the drain;
 * - dedupe keys prevent duplicate welcome/completion/left rows;
 * - lastError never contains the password;
 * - templates escape HTML in names/course titles, with text+HTML versions;
 * - triggers: enrollFree (new/reactivated/active), claimCertificate
 *   (new/existing), cancelMyEnrollment (changed/already-cancelled);
 * - enqueue failure does not fail enrollFree;
 * - internal drain route token check (GET/missing/wrong → 404).
 *
 * Runs through tsx via `npm test` (no Playwright). Fake `send` is injected;
 * production `cloudflare:sockets` is never touched.
 */
import "./helpers/env"; // MUST be first: throwaway DH_LOCAL_STATE_DIR + test secret.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { emailOutbox, getDb, type EmailOutboxRow } from "../src/lib/db";
import { migrateLocalDb } from "../src/lib/db/migrate";
import { disposeCloudflareBindings, getD1Database } from "../src/lib/cloudflare/bindings";
import { getAuth } from "../src/lib/auth";
import { getEmailConfig } from "../src/lib/email/config";
import {
  drainOutbox,
  enqueueEmail,
  requestEmailDelivery,
  sanitizeError,
} from "../src/lib/email/outbox";
import { SmtpError, SmtpMessageError } from "../src/lib/email/smtp";
import {
  courseCompletedTemplate,
  courseLeftTemplate,
  emailVerificationTemplate,
  enrollmentWelcomeTemplate,
  passwordResetTemplate,
} from "../src/lib/email/templates";
import { getDrainToken } from "../src/lib/email/drain-token";
import {
  createCourse,
  createLesson,
  createSection,
  publishCourse,
  publishLesson,
} from "../src/features/courses/service";
import { cancelMyEnrollment, enrollFree } from "../src/features/enrollments/service";
import { markLessonComplete } from "../src/features/progress/service";
import { claimCertificate } from "../src/features/certificates/service";

const nodeRequire = createRequire(__filename);
const uid = () => crypto.randomUUID().slice(0, 8);

const TEST_PASSWORD = "outbox-test-sentinel-pw-9";

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
  process.env.SMTP_USERNAME = "outbox-user@example.test";
  process.env.SMTP_PASSWORD = TEST_PASSWORD;
  process.env.MAIL_FROM_ADDRESS = "noreply@example.com";
}

function disableEmail(): void {
  delete process.env.SMTP_USERNAME;
  delete process.env.SMTP_PASSWORD;
  delete process.env.MAIL_FROM_ADDRESS;
}

async function clearOutbox(): Promise<void> {
  await (await getDb()).delete(emailOutbox).run();
}

async function outboxRows(toAddress?: string): Promise<EmailOutboxRow[]> {
  const db = await getDb();
  if (toAddress) {
    return db.select().from(emailOutbox).where(eq(emailOutbox.toAddress, toAddress));
  }
  return db.select().from(emailOutbox);
}

function sentCalls() {
  const ids: string[] = [];
  const send = async (row: EmailOutboxRow): Promise<void> => {
    ids.push(row.id);
  };
  return { send, ids };
}

async function account(name: string): Promise<{ id: string; email: string }> {
  const auth = await getAuth();
  const email = `outbox-${uid()}@example.test`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await auth.api.signUpEmail({ body: { email, password, name } });
  return { id: created.user.id, email };
}

test.before(async () => {
  await migrateLocalDb();
  stubModule("next/headers", { headers: async () => new Headers() });
  stubModule("next/cache", {
    revalidatePath: () => {},
    revalidateTag: () => {},
    unstable_cache: <T>(fn: T) => fn,
  });
});

test.after(async () => {
  disableEmail();
  await disposeCloudflareBindings();
});

// ---------------------------------------------------------------- config

test("email config defaults and enablement", () => {
  disableEmail();
  const disabled = getEmailConfig();
  assert.equal(disabled.host, "mail.spacemail.com");
  assert.equal(disabled.port, 465);
  assert.equal(disabled.fromName, "Decoded Hiring");
  assert.equal(disabled.enabled, false);
  enableEmail();
  assert.equal(getEmailConfig().enabled, true);
  disableEmail();
});

// ---------------------------------------------------------------- disabled

test("disabled config: rows stay pending and nothing is sent", async () => {
  disableEmail();
  await clearOutbox();
  const id = await requestEmailDelivery({
    kind: "password_reset",
    toAddress: "learner@example.com",
    subject: "Reset your password",
    textBody: "link",
  });
  assert.ok(id, "enqueue still returns an id when disabled");
  const { send, ids } = sentCalls();
  const counts = await drainOutbox({ send });
  assert.deepEqual(counts, { claimed: 0, sent: 0, retried: 0, failed: 0, expired: 0 });
  assert.equal(ids.length, 0);
  const rows = await outboxRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "pending");
});

// ---------------------------------------------------------------- success

test("success marks sent, stamps sentAt and clears bodies", async () => {
  enableEmail();
  await clearOutbox();
  const now = new Date("2026-11-20T10:00:00Z");
  await enqueueEmail({
    kind: "password_reset",
    toAddress: "learner@example.com",
    subject: "Reset your password",
    textBody: "secret-link-body",
    htmlBody: "<p>secret-link-body</p>",
    now,
  });
  const { send, ids } = sentCalls();
  const counts = await drainOutbox({ now, send });
  assert.deepEqual(counts, { claimed: 1, sent: 1, retried: 0, failed: 0, expired: 0 });
  assert.equal(ids.length, 1);
  const rows = await outboxRows();
  assert.equal(rows[0]?.status, "sent");
  assert.equal(rows[0]?.textBody, "");
  assert.equal(rows[0]?.htmlBody, null);
  assert.ok(rows[0]?.sentAt instanceof Date);
  disableEmail();
});

// ---------------------------------------------------------------- retry then fail

test("4xx retries with backoff (1m, 5m, 30m, 2h), then fails after 5 attempts", async () => {
  enableEmail();
  await clearOutbox();
  const t0 = new Date("2026-11-20T10:00:00Z");
  // 24 h expiry kind so the retry schedule (2h41m) never hits expiry first.
  await enqueueEmail({
    kind: "enrollment_welcome",
    toAddress: "learner@example.com",
    subject: "Welcome",
    textBody: "welcome",
    now: t0,
  });
  const failing = async (): Promise<void> => {
    throw new SmtpError(421, "RCPT", "4.7.0 Temporary failure");
  };
  const expectedBackoffs = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];
  let now = t0;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const counts = await drainOutbox({ now, send: failing });
    if (attempt < 5) {
      assert.deepEqual(counts, { claimed: 1, sent: 0, retried: 1, failed: 0, expired: 0 });
      const [row] = await outboxRows();
      assert.equal(row?.status, "pending");
      assert.equal(row?.attempts, attempt);
      const gap = (row?.nextAttemptAt.getTime() ?? 0) - now.getTime();
      assert.equal(gap, expectedBackoffs[attempt - 1], `backoff after attempt ${attempt}`);
      now = new Date((row?.nextAttemptAt.getTime() ?? 0) + 1000);
    } else {
      assert.deepEqual(counts, { claimed: 1, sent: 0, retried: 0, failed: 1, expired: 0 });
      const [row] = await outboxRows();
      assert.equal(row?.status, "failed");
      assert.equal(row?.attempts, 5);
      assert.equal(row?.textBody, "");
      assert.equal(row?.htmlBody, null);
      assert.match(row?.lastError ?? "", /421/);
    }
  }
  disableEmail();
});

// ---------------------------------------------------------------- permanent failure

test("5xx and validation errors fail immediately", async () => {
  enableEmail();
  await clearOutbox();
  const now = new Date();
  await enqueueEmail({ kind: "course_left", toAddress: "a@example.com", subject: "s", textBody: "b", now });
  await enqueueEmail({ kind: "course_left", toAddress: "c@example.com", subject: "s", textBody: "b", now });
  const send = async (row: EmailOutboxRow): Promise<void> => {
    if (row.toAddress === "a@example.com") throw new SmtpError(550, "RCPT", "5.1.1 Mailbox unavailable");
    throw new SmtpMessageError("Invalid email address in to: must look like local@domain");
  };
  const counts = await drainOutbox({ now, send });
  assert.deepEqual(counts, { claimed: 2, sent: 0, retried: 0, failed: 2, expired: 0 });
  for (const row of await outboxRows()) {
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 1);
    assert.equal(row.textBody, "");
  }
  disableEmail();
});

test("a rejected SMTP login pauses the drain without failing or spending attempts", async () => {
  enableEmail();
  await clearOutbox();
  const now = new Date();
  await enqueueEmail({ kind: "course_left", toAddress: "a@example.com", subject: "s", textBody: "b", now });
  await enqueueEmail({ kind: "course_left", toAddress: "b@example.com", subject: "s", textBody: "b", now });
  let calls = 0;
  const send = async (): Promise<void> => {
    calls += 1;
    throw new SmtpError(535, "AUTH", "5.7.8 Bad credentials");
  };
  const counts = await drainOutbox({ now, send });
  assert.equal(calls, 1, "the drain stops after the first rejected login");
  assert.deepEqual(counts, { claimed: 1, sent: 0, retried: 1, failed: 0, expired: 0 });
  for (const row of await outboxRows()) {
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.notEqual(row.textBody, "");
  }
  disableEmail();
});

// ---------------------------------------------------------------- expiry

test("rows past expiresAt are marked expired and never sent", async () => {
  enableEmail();
  await clearOutbox();
  const created = new Date("2026-11-20T10:00:00Z");
  // password_reset expires 1 h after creation.
  await enqueueEmail({
    kind: "password_reset",
    toAddress: "learner@example.com",
    subject: "Reset",
    textBody: "stale-link",
    htmlBody: "<p>stale-link</p>",
    now: created,
  });
  const { send, ids } = sentCalls();
  const counts = await drainOutbox({ now: new Date(created.getTime() + 2 * 3_600_000), send });
  assert.equal(ids.length, 0);
  assert.equal(counts.sent, 0);
  assert.equal(counts.expired, 1);
  const [row] = await outboxRows();
  assert.equal(row?.status, "expired");
  assert.equal(row?.textBody, "");
  assert.equal(row?.htmlBody, null);
  disableEmail();
});

// ---------------------------------------------------------------- lease

test("two drains running at the same time send a row only once", async () => {
  enableEmail();
  await clearOutbox();
  await enqueueEmail({
    kind: "enrollment_welcome",
    toAddress: "learner@example.com",
    subject: "Welcome",
    textBody: "welcome",
    now: new Date(),
  });
  const { send, ids } = sentCalls();
  const slowSend = async (row: EmailOutboxRow): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await send(row);
  };
  const [a, b] = await Promise.all([
    drainOutbox({ send: slowSend }),
    drainOutbox({ send: slowSend }),
  ]);
  assert.equal(ids.length, 1, "exactly one send across both drains");
  assert.equal(a.sent + b.sent, 1);
  assert.equal(a.claimed + b.claimed, 1);
  disableEmail();
});

test("a row with an expired lease is reclaimed and sent", async () => {
  enableEmail();
  await clearOutbox();
  const now = new Date("2026-11-20T10:00:00Z");
  const id = await enqueueEmail({
    kind: "enrollment_welcome",
    toAddress: "learner@example.com",
    subject: "Welcome",
    textBody: "welcome",
    now,
  });
  // Simulate a crashed drain: stuck in sending with a lease that lapsed.
  const db = await getDb();
  await db
    .update(emailOutbox)
    .set({ status: "sending", leaseUntil: new Date(now.getTime() - 1000) })
    .where(eq(emailOutbox.id, id))
    .run();
  const { send, ids } = sentCalls();
  const counts = await drainOutbox({ now, send });
  assert.deepEqual(counts, { claimed: 1, sent: 1, retried: 0, failed: 0, expired: 0 });
  assert.deepEqual(ids, [id]);
  disableEmail();
});

// ---------------------------------------------------------------- hourly cap

test("the 300/hour cap stops the drain and leaves pending rows alone", async () => {
  enableEmail();
  await clearOutbox();
  const now = new Date("2026-11-20T10:00:00Z");
  const db = await getDb();
  // 100 bound params per statement: 5 rows × 15 columns = 75 params per batch.
  const sentRows = Array.from({ length: 300 }, (_, i) => ({
    id: `email_cap_${String(i).padStart(3, "0")}`,
    kind: "enrollment_welcome" as const,
    toAddress: `cap${i}@example.com`,
    subject: "Welcome",
    textBody: "",
    htmlBody: null,
    status: "sent" as const,
    attempts: 1,
    nextAttemptAt: now,
    leaseUntil: null,
    lastError: null,
    expiresAt: new Date(now.getTime() + 24 * 3_600_000),
    dedupeKey: `cap-dedupe-${i}`,
    createdAt: new Date(now.getTime() - 30 * 60_000),
    sentAt: new Date(now.getTime() - 30 * 60_000),
  }));
  for (let i = 0; i < sentRows.length; i += 5) {
    await db.insert(emailOutbox).values(sentRows.slice(i, i + 5)).run();
  }
  await enqueueEmail({
    kind: "enrollment_welcome",
    toAddress: "learner@example.com",
    subject: "Welcome",
    textBody: "welcome",
    now,
  });
  const { send, ids } = sentCalls();
  const counts = await drainOutbox({ now, send });
  assert.equal(ids.length, 0);
  assert.equal(counts.sent, 0);
  assert.equal(counts.claimed, 0);
  const [pending] = await outboxRows("learner@example.com");
  assert.equal(pending?.status, "pending");
  disableEmail();
});

// ---------------------------------------------------------------- dedupe

test("dedupe: the same welcome/completion/left event queued twice stores one row", async () => {
  disableEmail();
  await clearOutbox();
  const first = await requestEmailDelivery({
    kind: "enrollment_welcome",
    toAddress: "learner@example.com",
    subject: "Welcome",
    textBody: "welcome",
    dedupeKey: "enrollment_welcome:u1:c1:123",
  });
  const second = await requestEmailDelivery({
    kind: "enrollment_welcome",
    toAddress: "learner@example.com",
    subject: "Welcome",
    textBody: "welcome",
    dedupeKey: "enrollment_welcome:u1:c1:123",
  });
  assert.equal(first, second, "conflict returns the pre-existing id");
  assert.equal((await outboxRows()).length, 1);
  // Distinct events are distinct rows.
  await requestEmailDelivery({
    kind: "course_completed",
    toAddress: "learner@example.com",
    subject: "Done",
    textBody: "done",
    dedupeKey: "course_completed:cert1",
  });
  await requestEmailDelivery({
    kind: "course_left",
    toAddress: "learner@example.com",
    subject: "Left",
    textBody: "left",
    dedupeKey: "course_left:u1:c1:456",
  });
  assert.equal((await outboxRows()).length, 3);
});

// ---------------------------------------------------------------- password in lastError

test("lastError never contains the password", async () => {
  enableEmail();
  await clearOutbox();
  const now = new Date();
  await enqueueEmail({ kind: "course_left", toAddress: "a@example.com", subject: "s", textBody: "b", now });
  const leaking = async (): Promise<void> => {
    // A misbehaving relay echoing the AUTH payload in its reply text.
    throw new SmtpError(554, "BODY", `5.7.8 rejected secret ${TEST_PASSWORD} end`);
  };
  const counts = await drainOutbox({ now, send: leaking });
  assert.equal(counts.failed, 1);
  const [row] = await outboxRows();
  assert.ok(row?.lastError);
  assert.ok(!row?.lastError?.includes(TEST_PASSWORD), "password is redacted");
  assert.ok((row?.lastError?.length ?? 0) <= 500);
  // Direct unit check: sanitizeError strips both secrets and truncates.
  const long = sanitizeError(`x ${TEST_PASSWORD} y outbox-user@example.test z`.repeat(100), getEmailConfig());
  assert.ok(!long.includes(TEST_PASSWORD));
  assert.ok(long.length <= 500);
  disableEmail();
});

// ---------------------------------------------------------------- templates

test("each template escapes HTML in names and course titles, with text and HTML", () => {
  const evilName = `Evil <script>alert("x")</script>`;
  const evilTitle = `Course "><img src=x onerror=alert(1)>`;
  const withName = [
    passwordResetTemplate({ userName: evilName, resetUrl: "https://example.com/reset?token=a&x=1" }),
    emailVerificationTemplate({ userName: evilName, verifyUrl: "https://example.com/verify?token=a&x=1" }),
    enrollmentWelcomeTemplate({ userName: evilName, courseTitle: "Plain title", courseUrl: "https://example.com/learn/courses/c" }),
    courseLeftTemplate({ userName: evilName, courseTitle: "Plain title", courseUrl: "https://example.com/learn/courses/c", leftDate: "2026-11-20" }),
  ];
  for (const t of withName) {
    assert.ok(t.subject.length > 0 && t.text.length > 0 && t.html.length > 0);
    assert.ok(!t.html.includes("<script>"), "no raw script tag in HTML");
    assert.ok(t.html.includes("&lt;script&gt;"), "name is escaped in HTML");
    assert.ok(t.text.includes(evilName), "text carries the same content");
    assert.ok(t.html.includes("Decoded Hiring"), "footer names the site");
    assert.ok(!t.html.includes("<img"), "no images");
  }
  const withTitle = [
    enrollmentWelcomeTemplate({ courseTitle: evilTitle, courseUrl: "https://example.com/learn/courses/c" }),
    courseCompletedTemplate({ courseTitle: evilTitle, certificateUrl: "https://example.com/certificates/ABC" }),
    courseLeftTemplate({ courseTitle: evilTitle, courseUrl: "https://example.com/learn/courses/c", leftDate: "2026-11-20" }),
  ];
  for (const t of withTitle) {
    assert.ok(t.subject.includes(evilTitle), "subject names the course");
    assert.ok(!t.html.includes("<img"), "title is escaped in HTML");
    assert.ok(t.html.includes("&lt;img"), "title escaping is visible");
    assert.ok(t.text.includes(evilTitle), "text carries the same content");
    assert.ok(t.html.includes("Decoded Hiring"), "footer names the site");
  }
  // Reset/verify specifics: validity window and ignore-line.
  const reset = passwordResetTemplate({ resetUrl: "https://example.com/r" });
  assert.match(reset.text, /1 hour/);
  assert.match(reset.text, /If you didn't ask for this, ignore this email/);
  assert.ok(reset.html.includes("https://example.com/r"));
  // Ampersands in URLs are escaped in attributes but raw in text.
  const verify = emailVerificationTemplate({ verifyUrl: "https://example.com/v?token=a&callbackURL=%2Flearn" });
  assert.ok(verify.html.includes("&amp;"));
  assert.ok(verify.text.includes("&callbackURL="));
});

// ---------------------------------------------------------------- triggers

async function makeCourse(certificate = false) {
  const course = await createCourse({
    title: `Outbox course ${uid()}`,
    slug: `outbox-course-${uid()}`,
    certificateEnabled: certificate,
  });
  const section = await createSection({ courseId: course.id, title: "Outbox section" });
  const lesson = await createLesson({
    courseId: course.id,
    sectionId: section.id,
    title: "Outbox lesson",
    slug: `outbox-lesson-${uid()}`,
    required: true,
  });
  await publishLesson(lesson.id);
  await publishCourse(course.id);
  return { course, lesson };
}

function welcomeKeys(rows: EmailOutboxRow[], userId: string, courseId: string): EmailOutboxRow[] {
  return rows.filter((r) =>
    r.kind === "enrollment_welcome" &&
    r.dedupeKey?.startsWith(`enrollment_welcome:${userId}:${courseId}:`),
  );
}

test("enrollFree: new and reactivated enrollments email once; already-active sends nothing", async () => {
  disableEmail();
  await clearOutbox();
  const learner = await account("Outbox Learner");
  const { course, lesson } = await makeCourse();

  await enrollFree(learner.id, course.id);
  let rows = await outboxRows(learner.email);
  assert.equal(welcomeKeys(rows, learner.id, course.id).length, 1, "new enrollment queues one welcome");

  await enrollFree(learner.id, course.id);
  rows = await outboxRows(learner.email);
  assert.equal(welcomeKeys(rows, learner.id, course.id).length, 1, "already-active queues nothing");

  await cancelMyEnrollment(learner.id, course.id);
  await enrollFree(learner.id, course.id);
  rows = await outboxRows(learner.email);
  assert.equal(welcomeKeys(rows, learner.id, course.id).length, 2, "reactivation queues a second welcome");
  void lesson;
});

test("claimCertificate: new issues email; repeat does not", async () => {
  disableEmail();
  await clearOutbox();
  const learner = await account("Outbox Graduate");
  const { course, lesson } = await makeCourse(true);
  const enrollment = await enrollFree(learner.id, course.id);
  await markLessonComplete(learner.id, enrollment.id, lesson.id);

  // Enroll + cancel noise from the flow above: scope to completion rows only.
  const before = (await outboxRows(learner.email)).filter((r) => r.kind === "course_completed");
  assert.equal(before.length, 0);
  const created = await claimCertificate(learner.id, course.slug, "Outbox Graduate");
  const after = (await outboxRows(learner.email)).filter((r) => r.kind === "course_completed");
  assert.equal(after.length, 1, "new certificate queues one completion email");
  assert.equal(after[0]?.dedupeKey, `course_completed:${created.id}`);
  assert.ok(after[0]?.subject.includes(course.title));
  assert.ok(after[0]?.textBody.includes(`/certificates/${created.id}`));

  await claimCertificate(learner.id, course.slug, "Outbox Graduate");
  const repeated = (await outboxRows(learner.email)).filter((r) => r.kind === "course_completed");
  assert.equal(repeated.length, 1, "existing certificate queues nothing");
});

test("cancelMyEnrollment: changed status emails once; already-cancelled sends nothing", async () => {
  disableEmail();
  await clearOutbox();
  const learner = await account("Outbox Leaver");
  const { course } = await makeCourse();
  await enrollFree(learner.id, course.id);

  await cancelMyEnrollment(learner.id, course.id);
  const leftKeys = (rows: EmailOutboxRow[]) =>
    rows.filter((r) =>
      r.kind === "course_left" &&
      r.dedupeKey?.startsWith(`course_left:${learner.id}:${course.id}:`),
    );
  let rows = await outboxRows(learner.email);
  assert.equal(leftKeys(rows).length, 1, "status change queues one left email");
  assert.ok(leftKeys(rows)[0]?.textBody.includes(course.title));
  assert.ok(leftKeys(rows)[0]?.textBody.includes("/learn/courses/"));

  await cancelMyEnrollment(learner.id, course.id);
  rows = await outboxRows(learner.email);
  assert.equal(leftKeys(rows).length, 1, "already-cancelled queues nothing");
});

// ---------------------------------------------------------------- enqueue failure

test("a failure in enqueue does not fail enrollFree or cancelMyEnrollment", async () => {
  disableEmail();
  await clearOutbox();
  const learner = await account("Outbox Resilient");
  const { course } = await makeCourse();

  // Break the outbox at the storage layer, then restore it afterwards.
  // Capture console.error to prove failure logs never carry addresses.
  const d1 = await getD1Database();
  await d1.prepare("DROP TABLE email_outbox").run();
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const enrollment = await enrollFree(learner.id, course.id);
    assert.equal(enrollment.status, "active", "enroll succeeds despite broken outbox");
    const left = await cancelMyEnrollment(learner.id, course.id);
    assert.equal(left.status, "cancelled", "cancel succeeds despite broken outbox");
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.length > 0, "failures were logged");
  for (const line of logged) {
    assert.ok(!line.includes(learner.email), "failure logs never carry addresses");
  }

  // Restore the table from the checked-in migration and prove it works again.
  const files = fs
    .readdirSync(path.join(process.cwd(), "drizzle", "migrations"))
    .filter((f) => f.startsWith("0029_") && f.endsWith(".sql"))
    .sort();
  assert.equal(files.length, 1);
  const sql = fs.readFileSync(path.join(process.cwd(), "drizzle", "migrations", files[0]!), "utf-8");
  for (const statement of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
    await d1.prepare(statement).run();
  }
  const id = await requestEmailDelivery({
    kind: "enrollment_welcome",
    toAddress: learner.email,
    subject: "Welcome back",
    textBody: "welcome",
  });
  assert.ok(id, "outbox works again after restore");
});

// ---------------------------------------------------------------- Better Auth wiring

test("better-auth wiring: signup queues verification; reset request queues, reset consumes and revokes sessions", async () => {
  disableEmail(); // enqueue still happens; nothing is sent.
  await clearOutbox();
  const auth = await getAuth();
  const email = `reset-flow-${uid()}@example.test`;
  const oldPassword = `Fixture-${crypto.randomUUID()}`;

  // Signup queues an email_verification row and still signs in
  // (requireEmailVerification stays false — no lockout). callbackURL mirrors
  // what the signup page sends, so the verify link lands on /learn?verified=1.
  const created = await auth.api.signUpEmail({
    body: { email, password: oldPassword, name: "Reset Flow", callbackURL: "/learn?verified=1" },
  });
  assert.ok(created.user.id, "signup succeeds without a verified email");
  const verifyRows = (await outboxRows(email)).filter((r) => r.kind === "email_verification");
  assert.equal(verifyRows.length, 1, "signup queued one verification email");
  assert.match(verifyRows[0]?.textBody ?? "", /\/verify-email\?token=/);
  assert.match(verifyRows[0]?.textBody ?? "", /callbackURL=%2Flearn%3Fverified%3D1/);

  // A pre-reset session exists (proves revocation below actually revokes).
  const userId = created.user.id;
  const db = await getDb();
  const { sessions } = await import("../src/lib/db");
  assert.ok(
    (await db.select().from(sessions).where(eq(sessions.userId, userId))).length >= 1,
    "signup minted a session",
  );

  // Reset request is generic and queues exactly one reset email (no throw for
  // unknown addresses either — enumeration-safe by construction).
  const requested = await auth.api.requestPasswordReset({
    body: { email, redirectTo: "/reset-password" },
  });
  assert.equal((requested as { status: boolean }).status, true);
  const unknown = await auth.api.requestPasswordReset({
    body: { email: `nobody-${uid()}@example.test`, redirectTo: "/reset-password" },
  });
  assert.equal((unknown as { status: boolean }).status, true, "unknown email still returns status true");
  const resetRows = (await outboxRows(email)).filter((r) => r.kind === "password_reset");
  assert.equal(resetRows.length, 1, "reset request queued one email");
  const resetUrl = resetRows[0]?.textBody.match(/https?:\/\/\S+/)?.[0];
  assert.ok(resetUrl, "reset email carries the reset link");
  const token = new URL(resetUrl).pathname.split("/").pop();
  assert.ok(token, "token extracted from the reset link");

  // Completing the reset consumes the token, revokes sessions, and rotates
  // the credential: old password fails, new password signs in.
  await auth.api.resetPassword({ body: { newPassword: "new-valid-password-123", token } });
  assert.equal(
    (await db.select().from(sessions).where(eq(sessions.userId, userId))).length,
    0,
    "revokeSessionsOnPasswordReset cleared sessions",
  );
  // Wrong credentials reject (Better Auth throws on invalid password).
  await assert.rejects(() => auth.api.signInEmail({ body: { email, password: oldPassword } }));
  const fresh = await auth.api.signInEmail({
    body: { email, password: "new-valid-password-123" },
    returnHeaders: true,
  });
  assert.ok(fresh.headers.getSetCookie().length > 0, "new password signs in");
});

// ---------------------------------------------------------------- internal drain route

test("internal drain route: GET, missing and wrong tokens return 404", async () => {
  disableEmail();
  await clearOutbox();
  const route = await import("../src/app/api/cron/email-drain/route");

  assert.equal((await route.GET()).status, 404, "GET returns 404");

  const noToken = await route.POST(new Request("https://example.com/api/cron/email-drain", { method: "POST" }));
  assert.equal(noToken.status, 404, "missing token returns 404");

  const wrongToken = await route.POST(
    new Request("https://example.com/api/cron/email-drain", {
      method: "POST",
      headers: { "x-email-drain-token": "wrong-token" },
    }),
  );
  assert.equal(wrongToken.status, 404, "wrong token returns 404");

  // Valid token drains (disabled here, so zeros) with private, no-store.
  const ok = await route.POST(
    new Request("https://example.com/api/cron/email-drain", {
      method: "POST",
      headers: { "x-email-drain-token": getDrainToken() },
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "private, no-store");
  const body = (await ok.json()) as Record<string, unknown>;
  assert.deepEqual(
    { claimed: body.claimed, sent: body.sent, retried: body.retried, failed: body.failed, expired: body.expired },
    { claimed: 0, sent: 0, retried: 0, failed: 0, expired: 0 },
  );
});
