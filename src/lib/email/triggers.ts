import { eq } from "drizzle-orm";
import { getDb, users } from "../db";
import { getSiteUrl } from "@/lib/seo";
import { redactEmails, requestEmailDelivery } from "./outbox";
import {
  courseCompletedTemplate,
  courseLeftTemplate,
  courseRestartedTemplate,
  emailVerificationTemplate,
  enrollmentWelcomeTemplate,
  passwordResetTemplate,
  questionAnsweredTemplate,
} from "./templates";

// ============================================================================
// EMAIL TRIGGERS (Batch G)
// ----------------------------------------------------------------------------
// Domain-event -> outbox glue. Every function is never-throwing: enqueue
// errors are caught and logged WITHOUT email addresses, so a mail failure
// can never fail the user's action (signup, enroll, claim, leave, reset).
// The recipient's email/name are looked up server-side from the users table.
// ============================================================================

function siteBase(): string {
  return getSiteUrl().toString().replace(/\/$/, "");
}

function leftDateLabel(when: Date): string {
  return when.toISOString().slice(0, 10);
}

async function lookupRecipient(userId: string): Promise<{ name: string; email: string } | null> {
  const db = await getDb();
  const row = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row ?? null;
}

function logTriggerFailure(kind: string, error: unknown): void {
  // Kind only — never the recipient address.
  console.error(
    `[email] trigger ${kind} failed:`,
    redactEmails(error instanceof Error ? error.message : String(error)),
  );
}

/** Better Auth `sendResetPassword`: reset link, valid 1 hour. No dedupe. */
export async function notifyPasswordReset(
  user: { name?: string | null; email: string },
  url: string,
): Promise<void> {
  try {
    const template = passwordResetTemplate({ userName: user.name ?? undefined, resetUrl: url });
    await requestEmailDelivery({
      kind: "password_reset",
      toAddress: user.email,
      subject: template.subject,
      textBody: template.text,
      htmlBody: template.html,
    });
  } catch (error) {
    logTriggerFailure("password_reset", error);
  }
}

/** Better Auth `sendVerificationEmail`: verify link, valid 1 hour. No dedupe. */
export async function notifyEmailVerification(
  user: { name?: string | null; email: string },
  url: string,
): Promise<void> {
  try {
    const template = emailVerificationTemplate({
      userName: user.name ?? undefined,
      verifyUrl: url,
    });
    await requestEmailDelivery({
      kind: "email_verification",
      toAddress: user.email,
      subject: template.subject,
      textBody: template.text,
      htmlBody: template.html,
    });
  } catch (error) {
    logTriggerFailure("email_verification", error);
  }
}

/** enrollFree created OR reactivated an enrollment (already-active: no email). */
export async function notifyEnrollmentWelcome(input: {
  userId: string;
  courseId: string;
  courseSlug: string;
  courseTitle: string;
  /** enrollment.createdAt for new rows, reactivation time for reactivated ones. */
  eventAt: Date;
}): Promise<void> {
  try {
    const recipient = await lookupRecipient(input.userId);
    if (!recipient) return;
    const template = enrollmentWelcomeTemplate({
      userName: recipient.name,
      courseTitle: input.courseTitle,
      courseUrl: `${siteBase()}/learn/courses/${input.courseSlug}`,
    });
    await requestEmailDelivery({
      kind: "enrollment_welcome",
      toAddress: recipient.email,
      subject: template.subject,
      textBody: template.text,
      htmlBody: template.html,
      dedupeKey: `enrollment_welcome:${input.userId}:${input.courseId}:${input.eventAt.getTime()}`,
    });
  } catch (error) {
    logTriggerFailure("enrollment_welcome", error);
  }
}

/** claimCertificate issued a NEW certificate (existing: no email). */
export async function notifyCourseCompleted(input: {
  userId: string;
  certificateId: string;
  courseTitle: string;
}): Promise<void> {
  try {
    const recipient = await lookupRecipient(input.userId);
    if (!recipient) return;
    const template = courseCompletedTemplate({
      userName: recipient.name,
      courseTitle: input.courseTitle,
      certificateUrl: `${siteBase()}/certificates/${input.certificateId}`,
    });
    await requestEmailDelivery({
      kind: "course_completed",
      toAddress: recipient.email,
      subject: template.subject,
      textBody: template.text,
      htmlBody: template.html,
      dedupeKey: `course_completed:${input.certificateId}`,
    });
  } catch (error) {
    logTriggerFailure("course_completed", error);
  }
}

/** restartMyEnrollment cleared lesson progress (no enrollment: no email). */
export async function notifyCourseRestarted(input: {
  userId: string;
  courseId: string;
  courseSlug: string;
  courseTitle: string;
  restartedAt: Date;
}): Promise<void> {
  try {
    const recipient = await lookupRecipient(input.userId);
    if (!recipient) return;
    const template = courseRestartedTemplate({
      userName: recipient.name,
      courseTitle: input.courseTitle,
      courseUrl: `${siteBase()}/learn/courses/${input.courseSlug}`,
    });
    await requestEmailDelivery({
      kind: "course_restarted",
      toAddress: recipient.email,
      subject: template.subject,
      textBody: template.text,
      htmlBody: template.html,
      dedupeKey: `course_restarted:${input.userId}:${input.courseId}:${input.restartedAt.getTime()}`,
    });
  } catch (error) {
    logTriggerFailure("course_restarted", error);
  }
}

/** cancelMyEnrollment actually changed the status (already-cancelled: no email). */
export async function notifyCourseLeft(input: {
  userId: string;
  courseId: string;
  courseSlug: string;
  courseTitle: string;
  cancelledAt: Date;
}): Promise<void> {
  try {
    const recipient = await lookupRecipient(input.userId);
    if (!recipient) return;
    const template = courseLeftTemplate({
      userName: recipient.name,
      courseTitle: input.courseTitle,
      courseUrl: `${siteBase()}/learn/courses/${input.courseSlug}`,
      leftDate: leftDateLabel(input.cancelledAt),
    });
    await requestEmailDelivery({
      kind: "course_left",
      toAddress: recipient.email,
      subject: template.subject,
      textBody: template.text,
      htmlBody: template.html,
      dedupeKey: `course_left:${input.userId}:${input.courseId}:${input.cancelledAt.getTime()}`,
    });
  } catch (error) {
    logTriggerFailure("course_left", error);
  }
}

/**
 * answerLessonQuestion answered (or re-answered) a question. Transactional
 * reply to the learner's own question — not a course nudge, so the
 * course-reminder opt-out does not apply. Queued once per question via the
 * dedupe key: editing an answer later never sends a second email.
 */
export async function notifyQuestionAnswered(input: {
  userId: string;
  courseTitle: string;
  courseSlug: string;
  lessonTitle: string;
  lessonSlug: string;
  questionId: string;
}): Promise<void> {
  try {
    const recipient = await lookupRecipient(input.userId);
    if (!recipient) return;
    const template = questionAnsweredTemplate({
      userName: recipient.name,
      courseTitle: input.courseTitle,
      lessonTitle: input.lessonTitle,
      lessonUrl: `${siteBase()}/learn/courses/${input.courseSlug}/lessons/${input.lessonSlug}`,
    });
    await requestEmailDelivery({
      kind: "question_answered",
      toAddress: recipient.email,
      subject: template.subject,
      textBody: template.text,
      htmlBody: template.html,
      dedupeKey: `question_answered:${input.questionId}`,
    });
  } catch (error) {
    logTriggerFailure("question_answered", error);
  }
}
