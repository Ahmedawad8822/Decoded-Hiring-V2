import { and, count, eq, gte, inArray, isNotNull, lte, or } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb, emailOutbox, type EmailOutboxKind, type EmailOutboxRow } from "../db";
import { getEmailConfig, type EmailConfig } from "./config";
import { sendMail, SmtpError, SmtpMessageError } from "./smtp";

// ============================================================================
// TRANSACTIONAL EMAIL OUTBOX (Batch G)
// ----------------------------------------------------------------------------
// Durable D1 queue. Requests enqueue rows (cheap indexed inserts); sending
// happens from `ctx.waitUntil` continuations and the 5-minute cron backstop
// via the internal drain route — never on the user's critical path.
//
// `drainOutbox` accepts injectable `send`/`config` so unit tests can drive it
// against a local D1 with a fake transport. Production passes nothing and
// gets the real SMTP path (lazy `cloudflare:sockets` import, so Node/tests
// never resolve the Workers-only specifier).
// ============================================================================

export interface EnqueueEmailInput {
  kind: EmailOutboxKind;
  toAddress: string;
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  dedupeKey?: string | null;
  now?: Date;
}

export interface DrainCounts {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  expired: number;
}

const ZERO_COUNTS: DrainCounts = { claimed: 0, sent: 0, retried: 0, failed: 0, expired: 0 };

/** Retry backoff after attempt N fails (1-indexed): 1m, 5m, 30m, 2h. */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];
const MAX_ATTEMPTS = 5;
// One send makes ~8 round trips at up to 15 s each; 5 min covers the worst case.
const LEASE_MS = 5 * 60_000;
const HOURLY_SEND_CAP = 300;

const SHORT_LIVED_KINDS: ReadonlySet<EmailOutboxKind> = new Set([
  "password_reset",
  "email_verification",
]);

const STALE_NUDGE_KINDS: ReadonlySet<EmailOutboxKind> = new Set([
  "lesson_unlocked",
  "nudge_completed",
  "nudge_inactive",
  "nudge_quiz_failed",
]);

export function expiryForKind(kind: EmailOutboxKind, now: Date): Date {
  // Batch J: unlock/nudge emails go stale fast — never send them late.
  if (STALE_NUDGE_KINDS.has(kind)) return new Date(now.getTime() + 48 * 3_600_000);
  const ttlMs = SHORT_LIVED_KINDS.has(kind) ? 3_600_000 : 24 * 3_600_000;
  return new Date(now.getTime() + ttlMs);
}

export type SendRowFn = (row: EmailOutboxRow, config: EmailConfig) => Promise<void>;

export interface DrainOptions {
  now?: Date;
  limit?: number;
  config?: EmailConfig;
  send?: SendRowFn;
}

async function productionSend(row: EmailOutboxRow, config: EmailConfig): Promise<void> {
  if (!config.username || !config.password || !config.fromAddress) {
    throw new Error("Email is not configured.");
  }
  const { connectSmtp } = await import("./sockets");
  await sendMail(
    {
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      from: { address: config.fromAddress, name: config.fromName },
      replyTo: config.replyTo,
      to: [row.toAddress],
      subject: row.subject,
      text: row.textBody,
      html: row.htmlBody ?? undefined,
    },
    { connect: connectSmtp },
  );
}

/**
 * Queue one email. Returns the row id (the pre-existing id when a
 * dedupeKey collides). Throws on invalid input or DB failure — callers that
 * must never fail the user (`requestEmailDelivery`, service triggers) catch.
 */
export async function enqueueEmail(input: EnqueueEmailInput): Promise<string> {
  const now = input.now ?? new Date();
  if (!input.toAddress || typeof input.toAddress !== "string") {
    throw new Error("enqueueEmail: toAddress is required.");
  }
  if (!input.subject || typeof input.subject !== "string") {
    throw new Error("enqueueEmail: subject is required.");
  }
  if (typeof input.textBody !== "string" || input.textBody.length === 0) {
    throw new Error("enqueueEmail: textBody is required.");
  }
  const db = await getDb();
  const id = `email_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db
    .insert(emailOutbox)
    .values({
      id,
      kind: input.kind,
      toAddress: input.toAddress,
      subject: input.subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody ?? null,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      lastError: null,
      expiresAt: expiryForKind(input.kind, now),
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
      sentAt: null,
    })
    .onConflictDoNothing(
      input.dedupeKey ? { target: emailOutbox.dedupeKey } : undefined,
    )
    .run();
  if (!input.dedupeKey) return id;
  const existing = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(eq(emailOutbox.dedupeKey, input.dedupeKey))
    .get();
  return existing?.id ?? id;
}

/** Bodies are wiped once a row is terminal, so links never sit in the DB. */
async function markTerminal(
  ids: string[],
  status: "sent" | "failed" | "expired",
  patch: Partial<Pick<EmailOutboxRow, "attempts" | "lastError" | "sentAt" | "nextAttemptAt" | "leaseUntil">>,
): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  await db
    .update(emailOutbox)
    .set({ status, textBody: "", htmlBody: null, ...patch })
    .where(inArray(emailOutbox.id, ids))
    .run();
}

/**
 * Redact email-address-like strings (defense in depth — Drizzle errors echo
 * bound params, so a raw error message can carry the recipient address).
 */
export function redactEmails(text: string): string {
  return text.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[redacted-address]",
  );
}

/**
 * Redact the SMTP password from an error string (defense in depth — SmtpError
 * text is built from server replies only, but a misbehaving relay could echo
 * the AUTH payload). Never logs or stores the password itself.
 */
export function sanitizeError(message: string, config: EmailConfig): string {
  let out = message;
  if (config.password && config.password.length > 0) {
    out = out.split(config.password).join("[redacted]");
  }
  if (config.username && config.username.length > 0) {
    out = out.split(config.username).join("[redacted]");
  }
  return redactEmails(out).slice(0, 500);
}

function isPermanentFailure(error: unknown): boolean {
  // 5xx never succeeds on retry (AUTH errors are handled by the caller as a
  // config problem). Validation errors (bad address, header injection) are
  // permanent.
  if (error instanceof SmtpMessageError) return true;
  if (error instanceof SmtpError) return error.code >= 500 && error.code <= 599;
  return false;
}

/**
 * Drain due rows: claim (conditional UPDATE so concurrent drains can't send
 * the same row), send, and record the outcome. Rows past expiresAt are marked
 * expired instead of sending. At most 300 sends per rolling hour. Returns
 * outcome counts. No-op when email is disabled.
 */
export async function drainOutbox(options: DrainOptions = {}): Promise<DrainCounts> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 10)));
  const config = options.config ?? getEmailConfig();
  if (!config.enabled) return { ...ZERO_COUNTS };
  const send = options.send ?? productionSend;
  const db = await getDb();

  // 1. Expire overdue rows instead of sending them.
  const overdue = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      and(
        inArray(emailOutbox.status, ["pending", "sending"]),
        lte(emailOutbox.expiresAt, now),
      ),
    )
    .limit(100);
  const expiredIds = overdue.map((r) => r.id);
  await markTerminal(expiredIds, "expired", { leaseUntil: null });

  // 2. Global cap: at most 300 sends per rolling hour.
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const sentCount = await db
    .select({ n: count() })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.status, "sent"), gte(emailOutbox.sentAt, hourAgo)))
    .get();
  if ((sentCount?.n ?? 0) >= HOURLY_SEND_CAP) {
    return { ...ZERO_COUNTS, expired: expiredIds.length };
  }

  // 3. Find up to `limit` due rows. The per-row conditional UPDATE below is
  // the mutual-exclusion point: a row already claimed by a concurrent drain
  // no longer matches (status flipped to sending with a live lease).
  const due = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      or(
        and(eq(emailOutbox.status, "pending"), lte(emailOutbox.nextAttemptAt, now)),
        and(
          eq(emailOutbox.status, "sending"),
          isNotNull(emailOutbox.leaseUntil),
          lte(emailOutbox.leaseUntil, now),
        ),
      ),
    )
    .orderBy(emailOutbox.nextAttemptAt)
    .limit(limit);
  const counts: DrainCounts = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    expired: expiredIds.length,
  };
  // 4. Claim each row right before sending it, so a lease always covers one
  // send. Claiming the whole batch up front would let a slow batch outlive
  // later rows' leases, and a concurrent drain would then send them twice.
  for (const candidate of due) {
    const claimAt = options.now ?? new Date();
    const result = await db
      .update(emailOutbox)
      .set({ status: "sending", leaseUntil: new Date(claimAt.getTime() + LEASE_MS) })
      .where(
        and(
          eq(emailOutbox.id, candidate.id),
          or(
            and(eq(emailOutbox.status, "pending"), lte(emailOutbox.nextAttemptAt, now)),
            and(
              eq(emailOutbox.status, "sending"),
              isNotNull(emailOutbox.leaseUntil),
              lte(emailOutbox.leaseUntil, now),
            ),
          ),
        ),
      )
      .returning()
      .all();
    const row = result[0];
    if (!row) continue;
    counts.claimed += 1;

    // Re-check expiry at send time: a row that crossed expiresAt while queued
    // behind the hourly cap is expired, not sent.
    if (row.expiresAt.getTime() <= now.getTime()) {
      await markTerminal([row.id], "expired", { leaseUntil: null });
      counts.expired += 1;
      continue;
    }
    const attempts = row.attempts + 1;
    try {
      await send(row, config);
      await markTerminal([row.id], "sent", {
        attempts,
        lastError: null,
        sentAt: now,
        leaseUntil: null,
      });
      counts.sent += 1;
    } catch (error: unknown) {
      const message = sanitizeError(
        error instanceof Error ? error.message : String(error),
        config,
      );
      // A rejected login is a configuration problem, not this email's fault:
      // put the row back without spending an attempt and stop the drain, so
      // a wrong password can't burn through every queued email as "failed".
      if (error instanceof SmtpError && error.stage === "AUTH") {
        await db
          .update(emailOutbox)
          .set({
            status: "pending",
            lastError: message,
            nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS[1]!),
            leaseUntil: null,
          })
          .where(eq(emailOutbox.id, row.id))
          .run();
        counts.retried += 1;
        console.error("[email] SMTP login rejected; check SMTP_USERNAME / SMTP_PASSWORD.");
        break;
      }
      if (isPermanentFailure(error) || attempts >= MAX_ATTEMPTS) {
        await markTerminal([row.id], "failed", {
          attempts,
          lastError: message,
          leaseUntil: null,
        });
        counts.failed += 1;
      } else {
        const backoff = RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
        await db
          .update(emailOutbox)
          .set({
            status: "pending",
            attempts,
            lastError: message,
            nextAttemptAt: new Date(now.getTime() + backoff),
            leaseUntil: null,
          })
          .where(eq(emailOutbox.id, row.id))
          .run();
        counts.retried += 1;
      }
    }
  }
  return counts;
}

/**
 * Never-throwing enqueue + immediate-drain scheduling for request paths.
 * Enqueue errors are caught and logged WITHOUT email addresses; the drain is
 * scheduled on the request's waitUntil so it never delays or fails the
 * response. No-op outside a Workers request context (Node tests).
 */
export async function requestEmailDelivery(input: EnqueueEmailInput): Promise<string | null> {
  let id: string;
  try {
    id = await enqueueEmail(input);
  } catch (error) {
    // Log the kind only — never the recipient address (Drizzle errors echo
    // bound params, so the raw message is redacted first).
    console.error(
      `[email] enqueue failed for kind=${input.kind}:`,
      redactEmails(error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
  scheduleImmediateDrain();
  return id;
}

/** Schedule `drainOutbox({ limit: 3 })` on the request's waitUntil. */
export function scheduleImmediateDrain(): void {
  try {
    const { ctx } = getCloudflareContext();
    ctx.waitUntil(
      drainOutbox({ limit: 3 }).catch((error: unknown) => {
        console.error(
          "[email] immediate drain failed:",
          redactEmails(error instanceof Error ? error.message : String(error)),
        );
      }),
    );
  } catch {
    // No request context (Node tests, build): the cron backstop covers it.
  }
}
