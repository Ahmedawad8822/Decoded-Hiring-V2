import { siteName } from "@/lib/seo";

// ============================================================================
// TRANSACTIONAL EMAIL TEMPLATES (Batch G)
// ----------------------------------------------------------------------------
// Pure functions: ({...fields}) => { subject, text, html }. No I/O, no env
// reads — callers build absolute URLs from NEXT_PUBLIC_SITE_URL /
// BETTER_AUTH_URL (the same way the rest of the app does) and pass them in.
//
// Format: plain, accessible HTML (inline styles only, single column, no
// images, no tracking pixels, no external fonts). Every interpolated value
// is HTML-escaped; the text version carries the same content. Each email has
// a short footer saying why it was sent, plus the site name. No marketing.
// ============================================================================

export interface EmailTemplate {
  subject: string;
  text: string;
  html: string;
}

/** Escape every interpolated value for HTML bodies (text bodies carry raw values). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, heading: string, bodyParagraphs: string[], footer: string): string {
  const body = bodyParagraphs.map((p) => `<p style="margin:0 0 12px 0;">${p}</p>`).join("");
  return (
    `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px 16px;">` +
    `<h1 style="font-size:20px;margin:0 0 16px 0;">${title}</h1>` +
    `<p style="margin:0 0 12px 0;">${heading}</p>` +
    body +
    `<hr style="border:none;border-top:1px solid #dddddd;margin:24px 0 12px 0;" />` +
    `<p style="font-size:12px;color:#666666;margin:0;">${footer}</p>` +
    `</div>`
  );
}

function footerFor(reason: string): string {
  return `${reason} This is a transactional message from ${escapeHtml(siteName)} — no reply needed unless the message asks for one.`;
}

function link(url: string, label: string): string {
  const safeUrl = escapeHtml(url);
  const safeLabel = escapeHtml(label);
  return `<a href="${safeUrl}" style="color:#1a56db;">${safeLabel}</a>`;
}

// ---------------------------------------------------------------- password reset

export function passwordResetTemplate(input: {
  userName?: string;
  resetUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = "Reset your password";
  const text =
    `${greeting}\n\n` +
    `Someone asked to reset the password for this email address. Use the link below within 1 hour:\n\n` +
    `${input.resetUrl}\n\n` +
    `If you didn't ask for this, ignore this email — your password stays the same.\n\n` +
    `— ${siteName}`;
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    [
      "Someone asked to reset the password for this email address. Use the link below within 1 hour:",
      link(input.resetUrl, "Reset your password"),
      "If you didn't ask for this, ignore this email — your password stays the same.",
    ],
    escapeHtml(
      footerFor("You got this email because a password reset was requested for this address."),
    ),
  );
  return { subject, text, html };
}

// ---------------------------------------------------------------- email verification

export function emailVerificationTemplate(input: {
  userName?: string;
  verifyUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = "Verify your email address";
  const text =
    `${greeting}\n\n` +
    `Thanks for creating an account. Confirm this email address with the link below (valid for 1 hour):\n\n` +
    `${input.verifyUrl}\n\n` +
    `If you didn't create an account, ignore this email.\n\n` +
    `— ${siteName}`;
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    [
      "Thanks for creating an account. Confirm this email address with the link below (valid for 1 hour):",
      link(input.verifyUrl, "Verify your email address"),
      "If you didn't create an account, ignore this email.",
    ],
    escapeHtml(
      footerFor("You got this email because an account was created with this address."),
    ),
  );
  return { subject, text, html };
}

// ---------------------------------------------------------------- enrollment welcome

export function enrollmentWelcomeTemplate(input: {
  userName?: string;
  courseTitle: string;
  courseUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = `You're enrolled: ${input.courseTitle}`;
  const text =
    `${greeting}\n\n` +
    `You're enrolled in "${input.courseTitle}". Start learning here:\n\n` +
    `${input.courseUrl}\n\n` +
    `Your place is saved as you go.\n\n` +
    `— ${siteName}`;
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    [
      `You&rsquo;re enrolled in &ldquo;${escapeHtml(input.courseTitle)}&rdquo;. Start learning here:`,
      link(input.courseUrl, input.courseTitle),
      "Your place is saved as you go.",
    ],
    escapeHtml(
      footerFor("You got this email because you enrolled in this course."),
    ),
  );
  return { subject, text, html };
}

// ---------------------------------------------------------------- course completed

export function courseCompletedTemplate(input: {
  userName?: string;
  courseTitle: string;
  certificateUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = `Course complete: ${input.courseTitle}`;
  const text =
    `${greeting}\n\n` +
    `You completed "${input.courseTitle}". Your certificate is ready here:\n\n` +
    `${input.certificateUrl}\n\n` +
    `Well done — keep going.\n\n` +
    `— ${siteName}`;
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    [
      `You completed &ldquo;${escapeHtml(input.courseTitle)}&rdquo;. Your certificate is ready here:`,
      link(input.certificateUrl, "View your certificate"),
      "Well done — keep going.",
    ],
    escapeHtml(
      footerFor("You got this email because you completed this course."),
    ),
  );
  return { subject, text, html };
}

// ---------------------------------------------------------------- course left

export function courseLeftTemplate(input: {
  userName?: string;
  courseTitle: string;
  courseUrl: string;
  leftDate: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = `You left ${input.courseTitle}`;
  const text =
    `${greeting}\n\n` +
    `You left "${input.courseTitle}" on ${input.leftDate}.\n\n` +
    `Your progress and notes are kept. Rejoin any time here:\n\n` +
    `${input.courseUrl}\n\n` +
    `— ${siteName}`;
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    [
      `You left &ldquo;${escapeHtml(input.courseTitle)}&rdquo; on ${escapeHtml(input.leftDate)}.`,
      `Your progress and notes are kept. Rejoin any time here: ${link(input.courseUrl, input.courseTitle)}`,
    ],
    escapeHtml(
      footerFor("You got this email because you left this course."),
    ),
  );
  return { subject, text, html };
}

// ---------------------------------------------------------------- course restarted

export function courseRestartedTemplate(input: {
  userName?: string;
  courseTitle: string;
  courseUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = `You restarted ${input.courseTitle}`;
  const text =
    `${greeting}\n\n` +
    `You restarted "${input.courseTitle}". Your lesson progress is cleared so you can go through it fresh.\n\n` +
    `Your quiz attempts, notes and certificates are kept. Start again here:\n\n` +
    `${input.courseUrl}\n\n` +
    `— ${siteName}`;
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    [
      `You restarted &ldquo;${escapeHtml(input.courseTitle)}&rdquo;. Your lesson progress is cleared so you can go through it fresh.`,
      `Your quiz attempts, notes and certificates are kept. Start again here: ${link(input.courseUrl, input.courseTitle)}`,
    ],
    escapeHtml(
      footerFor("You got this email because you restarted this course."),
    ),
  );
  return { subject, text, html };
}

// ---------------------------------------------------------------- Batch J learner automations
//
// Course reminder emails: unlock announcements + three fixed nudges. Every one
// carries an unsubscribe link (course reminders opt-out). Same plain styling
// as the transactional templates; every interpolated value is escaped.

function automationFooter(reason: string, unsubscribeUrl: string): string {
  return (
    `${reason} ` +
    `Don't want these emails? ${`Unsubscribe from course reminders: ${unsubscribeUrl}`} ` +
    `This is a message from ${siteName}.`
  );
}

function nudgeParagraphs(bodyParagraphs: string[], unsubscribeUrl: string): string[] {
  return [...bodyParagraphs, `Don't want these emails? ${link(unsubscribeUrl, "Unsubscribe from course reminders")}`];
}

function nudgeText(text: string, unsubscribeUrl: string): string {
  return `${text}\n\nDon't want these emails? Unsubscribe from course reminders:\n\n${unsubscribeUrl}\n\n— ${siteName}`;
}

export function lessonUnlockedTemplate(input: {
  userName?: string;
  courseTitle: string;
  lessonTitle: string;
  lessonUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = `New lesson unlocked: ${input.lessonTitle}`;
  const text = nudgeText(
    `${greeting}\n\nA new lesson unlocked in "${input.courseTitle}": "${input.lessonTitle}".\n\nContinue here:\n\n${input.lessonUrl}`,
    input.unsubscribeUrl,
  );
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    nudgeParagraphs(
      [
        `A new lesson unlocked in &ldquo;${escapeHtml(input.courseTitle)}&rdquo;: &ldquo;${escapeHtml(input.lessonTitle)}&rdquo;.`,
        `Continue here: ${link(input.lessonUrl, input.lessonTitle)}`,
      ],
      input.unsubscribeUrl,
    ),
    escapeHtml(
      automationFooter(
        "You got this email because a lesson unlocked in a course you're taking.",
        input.unsubscribeUrl,
      ),
    ),
  );
  return { subject, text, html };
}

export function nudgeCompletedTemplate(input: {
  userName?: string;
  courseTitle: string;
  coachingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = `What's next after ${input.courseTitle}?`;
  const text = nudgeText(
    `${greeting}\n\nYou completed "${input.courseTitle}" — well done. If you want to go further, a coaching call can help you apply it:\n\n${input.coachingUrl}`,
    input.unsubscribeUrl,
  );
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    nudgeParagraphs(
      [
        `You completed &ldquo;${escapeHtml(input.courseTitle)}&rdquo; — well done. If you want to go further, a coaching call can help you apply it:`,
        link(input.coachingUrl, "Book a coaching call"),
      ],
      input.unsubscribeUrl,
    ),
    escapeHtml(
      automationFooter("You got this email because you completed this course.", input.unsubscribeUrl),
    ),
  );
  return { subject, text, html };
}

export function nudgeInactiveTemplate(input: {
  userName?: string;
  courseTitle: string;
  courseUrl: string;
  coachingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = `Pick up where you left off in ${input.courseTitle}`;
  const text = nudgeText(
    `${greeting}\n\nIt's been a week since your last session in "${input.courseTitle}". Small steps count — pick up where you left off:\n\n${input.courseUrl}\n\nWant a hand? ${input.coachingUrl}`,
    input.unsubscribeUrl,
  );
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    nudgeParagraphs(
      [
        `It&rsquo;s been a week since your last session in &ldquo;${escapeHtml(input.courseTitle)}&rdquo;. Small steps count — pick up where you left off:`,
        link(input.courseUrl, input.courseTitle),
        `Want a hand? ${link(input.coachingUrl, "Book a coaching call")}`,
      ],
      input.unsubscribeUrl,
    ),
    escapeHtml(
      automationFooter(
        "You got this email because you paused this course for a week.",
        input.unsubscribeUrl,
      ),
    ),
  );
  return { subject, text, html };
}

export function nudgeQuizFailedTemplate(input: {  userName?: string;
  courseTitle: string;
  lessonTitle: string;
  quizUrl: string;
  coachingUrl: string;
  unsubscribeUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = `Stuck on ${input.lessonTitle}? Let's talk it through`;
  const text = nudgeText(
    `${greeting}\n\nThe quiz in "${input.lessonTitle}" (${input.courseTitle}) didn't pass twice. That's normal — a quick call can unblock you:\n\n${input.coachingUrl}\n\nOr try the quiz again here:\n\n${input.quizUrl}`,
    input.unsubscribeUrl,
  );
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    nudgeParagraphs(
      [
        `The quiz in &ldquo;${escapeHtml(input.lessonTitle)}&rdquo; (&ldquo;${escapeHtml(input.courseTitle)}&rdquo;) didn&rsquo;t pass twice. That&rsquo;s normal — a quick call can unblock you:`,
        link(input.coachingUrl, "Book a call"),
        `Or try the quiz again here: ${link(input.quizUrl, input.lessonTitle)}`,
      ],
      input.unsubscribeUrl,
    ),
    escapeHtml(
      automationFooter(
        "You got this email because a quiz in your course needs another try.",
        input.unsubscribeUrl,
      ),
    ),
  );
  return { subject, text, html };
}

// ---------------------------------------------------------------- question answered
// Transactional reply to a learner's own lesson question (not a nudge, so no
// unsubscribe link and no course-reminder opt-out applies).

export function questionAnsweredTemplate(input: {
  userName?: string;
  courseTitle: string;
  lessonTitle: string;
  lessonUrl: string;
}): EmailTemplate {
  const greeting = input.userName ? `Hi ${input.userName},` : "Hi,";
  const subject = `Your question on ${input.lessonTitle} was answered`;
  const text =
    `${greeting}\n\n` +
    `Your question on "${input.lessonTitle}" (${input.courseTitle}) has an answer. Read it here:\n\n` +
    `${input.lessonUrl}\n\n` +
    `— ${siteName}`;
  const html = shell(
    escapeHtml(subject),
    escapeHtml(greeting),
    [
      `Your question on &ldquo;${escapeHtml(input.lessonTitle)}&rdquo; (&ldquo;${escapeHtml(input.courseTitle)}&rdquo;) has an answer. Read it here:`,
      link(input.lessonUrl, input.lessonTitle),
    ],
    escapeHtml(
      footerFor("You got this email because you asked a question on this lesson."),
    ),
  );
  return { subject, text, html };
}
