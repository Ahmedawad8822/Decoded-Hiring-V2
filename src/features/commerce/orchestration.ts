// ============================================================================
// DURABLE SCHEDULING & COMMUNICATIONS ORCHESTRATION (Mission 08.5)
// ----------------------------------------------------------------------------
// D1-backed outbox with lease/CAS ownership. Provider calls happen outside D1
// transactions, but retries reuse the same internal idempotency key. A crash
// after provider success and before D1 success is therefore recoverable without
// intentionally creating duplicate provider side effects.
// ============================================================================

import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  bookingTypes,
  bookings,
  offers,
  orchestrationEffects,
  orchestrationHistory,
  orders,
  type OrchestrationEffect,
  type OrchestrationEffectStatus,
  type OrchestrationHistory,
} from "@/lib/db";
import { getDb } from "@/lib/db";
import { getD1Database } from "@/lib/cloudflare/bindings";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import {
  SchedulingProviderError,
  UnconfiguredCommerceSchedulingProviders,
  type CommerceSchedulingProviders,
  type ProviderRuntimeStatus,
} from "@/features/scheduling";
import {
  CommerceDomainError,
  fulfillPaidOrderFromOrchestration,
  getOrderById,
} from "./orders";
import {
  bookingEffectPayloadSchema,
  enqueueEffectSchema,
  paymentCheckoutPayloadSchema,
  processEffectSchema,
  type EnqueueEffectInput,
  type ProcessEffectInput,
} from "./orchestration-schemas";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

function toUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

function detail(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function payloadJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export async function getOrchestrationEffect(
  id: string,
): Promise<OrchestrationEffect | undefined> {
  const db = await getDb();
  return db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.id, id))
    .get();
}

export async function getEffectByIdempotencyKey(
  idempotencyKey: string,
): Promise<OrchestrationEffect | undefined> {
  const db = await getDb();
  return db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.idempotencyKey, idempotencyKey))
    .get();
}

export async function getOrchestrationHistory(
  effectId: string,
): Promise<OrchestrationHistory[]> {
  const db = await getDb();
  return db
    .select()
    .from(orchestrationHistory)
    .where(eq(orchestrationHistory.effectId, effectId))
    .orderBy(asc(orchestrationHistory.createdAt))
    .all();
}

function assertEffectBinding(
  existing: OrchestrationEffect,
  input: EnqueueEffectInput,
): OrchestrationEffect {
  if (
    existing.subjectType !== input.subjectType ||
    existing.subjectId !== input.subjectId ||
    existing.effectType !== input.effectType ||
    existing.providerKind !== input.providerKind ||
    (existing.dependsOnEffectId ?? null) !== (input.dependsOnEffectId ?? null) ||
    existing.payload !== payloadJson(input.payload)
  ) {
    throw new CommerceDomainError(
      "This orchestration idempotency key is already bound to a different effect.",
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return existing;
}

export async function enqueueOrchestrationEffect(
  input: EnqueueEffectInput,
): Promise<OrchestrationEffect> {
  const parsed = enqueueEffectSchema.parse(input);
  const existing = await getEffectByIdempotencyKey(parsed.idempotencyKey);
  if (existing) return assertEffectBinding(existing, parsed);

  if (parsed.dependsOnEffectId) {
    const dependency = await getOrchestrationEffect(parsed.dependsOnEffectId);
    if (!dependency) {
      throw new CommerceDomainError(
        "Orchestration dependency does not exist.",
        "DEPENDENCY_NOT_READY",
      );
    }
  }

  const db = await getDb();
  const id = newId("fx");
  try {
    await db.batch([
      db.insert(orchestrationEffects).values({
        id,
        subjectType: parsed.subjectType,
        subjectId: parsed.subjectId,
        effectType: parsed.effectType,
        providerKind: parsed.providerKind,
        idempotencyKey: parsed.idempotencyKey,
        dependsOnEffectId: parsed.dependsOnEffectId ?? null,
        payload: payloadJson(parsed.payload),
        status: "PENDING",
        attemptCount: 0,
        createdAt: parsed.now,
        updatedAt: parsed.now,
      }),
      db.insert(orchestrationHistory).values({
        id: newId("fxh"),
        effectId: id,
        action: "ENQUEUED",
        fromStatus: null,
        toStatus: "PENDING",
        detail: detail({ idempotencyKey: parsed.idempotencyKey }),
        createdAt: parsed.now,
      }),
    ]);
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      const winner = await getEffectByIdempotencyKey(parsed.idempotencyKey);
      if (winner) return assertEffectBinding(winner, parsed);
    }
    throw error;
  }

  const created = await getOrchestrationEffect(id);
  if (!created) throw new Error("Effect insert committed but could not be re-read.");
  return created;
}

export async function enqueuePaymentCheckout(params: {
  orderId: string;
  successUrl: string;
  cancelUrl: string;
  now: Date;
}): Promise<OrchestrationEffect> {
  const order = await getOrderById(params.orderId);
  if (!order) throw new CommerceDomainError("Order not found.", "ORDER_NOT_FOUND");
  if (order.status !== "PENDING" && order.status !== "REQUIRES_ACTION") {
    throw new CommerceDomainError(
      `Cannot create checkout for order in ${order.status} state.`,
      "INVALID_TRANSITION",
    );
  }
  return enqueueOrchestrationEffect({
    subjectType: "ORDER",
    subjectId: order.id,
    effectType: "PAYMENT_CHECKOUT_CREATE",
    providerKind: "payment",
    idempotencyKey: `order:${order.id}:checkout`,
    payload: {
      orderId: order.id,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    },
    now: params.now,
  });
}

export async function enqueueBookingReminder(params: {
  bookingId: string;
  reminderKey: string;
  now: Date;
}): Promise<OrchestrationEffect> {
  return enqueueOrchestrationEffect({
    subjectType: "BOOKING",
    subjectId: params.bookingId,
    effectType: "MAIL_REMINDER",
    providerKind: "mailbox",
    idempotencyKey: `booking:${params.bookingId}:reminder:${params.reminderKey}`,
    payload: { bookingId: params.bookingId },
    now: params.now,
  });
}

async function providerKindStatus(
  kind: OrchestrationEffect["providerKind"],
  providers: CommerceSchedulingProviders,
): Promise<ProviderRuntimeStatus> {
  switch (kind) {
    case "payment":
      return providers.payment.getStatus();
    case "calendar":
      return providers.calendar.getStatus();
    case "mailbox":
      return providers.mailbox.getStatus();
    case "meeting":
      return providers.meeting.getStatus();
    case "internal":
      return {
        kind: "payment",
        provider: "decoded-hiring-internal",
        configured: true,
        capabilities: ["internal_fulfillment"],
      };
  }
}

async function providerStatus(
  effect: OrchestrationEffect,
  providers: CommerceSchedulingProviders,
): Promise<ProviderRuntimeStatus> {
  return providerKindStatus(effect.providerKind, providers);
}

async function dependencySatisfied(effect: OrchestrationEffect): Promise<boolean> {
  if (!effect.dependsOnEffectId) return true;
  const dependency = await getOrchestrationEffect(effect.dependsOnEffectId);
  return dependency?.status === "SUCCEEDED";
}

async function claimEffect(
  effect: OrchestrationEffect,
  input: { effectId: string; now: Date; leaseSeconds: number },
): Promise<OrchestrationEffect | null> {
  const nowSec = toUnixSeconds(input.now);

  if (effect.status === "SUCCEEDED" || effect.status === "TERMINAL_FAILURE") {
    return null;
  }
  if (effect.nextAttemptAt && effect.nextAttemptAt > input.now) return null;
  if (!(await dependencySatisfied(effect))) return null;

  if (
    effect.status === "PROCESSING" &&
    effect.leaseExpiresAt &&
    effect.leaseExpiresAt > input.now
  ) {
    return null;
  }

  const claimToken = `fxclaim_${crypto.randomUUID()}`;
  const leaseExpiresSec = nowSec + input.leaseSeconds;
  const previousStatus = effect.status;
  const action =
    previousStatus === "PROCESSING" ? "LEASE_RECOVERED" : "CLAIMED";
  const d1 = await getD1Database();

  await d1.batch([
    d1
      .prepare(
        `UPDATE orchestration_effects
         SET status='PROCESSING',
             attempt_count=attempt_count+1,
             claim_token=?,
             transition_key=NULL,
             lease_expires_at=?,
             last_attempt_at=?,
             updated_at=?
         WHERE id=?
           AND (
             status IN ('PENDING','RETRYABLE_FAILURE','BLOCKED')
             OR (status='PROCESSING' AND lease_expires_at <= ?)
           )
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      )
      .bind(
        claimToken,
        leaseExpiresSec,
        nowSec,
        nowSec,
        effect.id,
        nowSec,
        nowSec,
      ),
    d1
      .prepare(
        `INSERT INTO orchestration_history
         (id, effect_id, action, from_status, to_status, detail, created_at)
         SELECT ?, id, ?, ?, 'PROCESSING', ?, ?
         FROM orchestration_effects
         WHERE id=? AND claim_token=? AND status='PROCESSING'`,
      )
      .bind(
        newId("fxh"),
        action,
        previousStatus,
        detail({ claimToken, leaseSeconds: input.leaseSeconds }),
        nowSec,
        effect.id,
        claimToken,
      ),
  ]);

  const claimed = await getOrchestrationEffect(effect.id);
  if (
    !claimed ||
    claimed.status !== "PROCESSING" ||
    claimed.claimToken !== claimToken
  ) {
    return null;
  }
  return claimed;
}

async function getBookingContext(bookingId: string) {
  const db = await getDb();
  const booking = await db.select().from(bookings).where(eq(bookings.id, bookingId)).get();
  if (!booking) {
    throw new CommerceDomainError("Booking not found.", "DEPENDENCY_NOT_READY");
  }
  const bookingType = await db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.id, booking.bookingTypeId))
    .get();
  if (!bookingType) {
    throw new CommerceDomainError("Booking type not found.", "DEPENDENCY_NOT_READY");
  }
  return { booking, bookingType };
}

async function latestCalendarRef(bookingId: string): Promise<{
  id: string;
  provider: string;
} | null> {
  const db = await getDb();
  const effects = await db
    .select()
    .from(orchestrationEffects)
    .where(
      and(
        eq(orchestrationEffects.subjectType, "BOOKING"),
        eq(orchestrationEffects.subjectId, bookingId),
        eq(orchestrationEffects.status, "SUCCEEDED"),
      ),
    )
    .orderBy(desc(orchestrationEffects.succeededAt))
    .all();

  for (const effect of effects) {
    if (
      effect.effectType !== "CALENDAR_CREATE" &&
      effect.effectType !== "CALENDAR_UPDATE"
    ) {
      continue;
    }
    if (!effect.providerRef) continue;
    try {
      const parsed = JSON.parse(effect.providerRef) as {
        event?: { id?: unknown; provider?: unknown };
      };
      if (
        typeof parsed.event?.id === "string" &&
        typeof parsed.event?.provider === "string"
      ) {
        return { id: parsed.event.id, provider: parsed.event.provider };
      }
    } catch {
      // Ignore malformed historical provider refs and continue searching.
    }
  }
  return null;
}

async function handlePaymentCheckout(
  effect: OrchestrationEffect,
  providers: CommerceSchedulingProviders,
): Promise<string> {
  const payload = paymentCheckoutPayloadSchema.parse(JSON.parse(effect.payload));
  const db = await getDb();
  const order = await getOrderById(payload.orderId);
  if (!order) throw new CommerceDomainError("Order not found.", "ORDER_NOT_FOUND");
  const offer = await db.select().from(offers).where(eq(offers.id, order.offerId)).get();
  if (!offer) throw new CommerceDomainError("Offer not found.", "OFFER_NOT_FOUND");
  if (!order.currency || order.amountMinor == null || order.amountMinor <= 0) {
    throw new CommerceDomainError(
      "Order has no provider-payable amount.",
      "ORDER_NOT_ALLOWED",
    );
  }

  const result = await providers.payment.createCheckout({
    orderId: order.id,
    offerId: offer.id,
    amountMinor: order.amountMinor * order.quantity,
    currency: order.currency,
    quantity: order.quantity,
    customer: { email: order.customerEmail },
    successUrl: payload.successUrl,
    cancelUrl: payload.cancelUrl,
    idempotencyKey: effect.idempotencyKey,
    metadata: {
      orderId: order.id,
      offerId: offer.id,
    },
  });

  try {
    const url = new URL(result.checkoutUrl);
    if (
      url.protocol !== "https:" ||
      Boolean(url.username) ||
      Boolean(url.password)
    ) {
      throw new Error("unsafe checkout URL");
    }
  } catch {
    throw new SchedulingProviderError({
      message: "Payment provider returned an invalid checkout URL.",
      code: "INVALID_PROVIDER_RESPONSE",
      providerKind: "payment",
      operation: "createCheckout",
      retryable: false,
    });
  }

  const current = await getOrderById(order.id);
  if (!current) throw new CommerceDomainError("Order not found.", "ORDER_NOT_FOUND");
  if (
    current.providerCheckoutId &&
    current.providerCheckoutId !== result.providerCheckoutId
  ) {
    throw new SchedulingProviderError({
      message: "Payment provider changed checkout identity for the same idempotency key.",
      code: "INVALID_PROVIDER_RESPONSE",
      providerKind: "payment",
      operation: "createCheckout",
      retryable: false,
    });
  }

  if (current.status === "PENDING") {
    const d1 = await getD1Database();
    const nowSec = effect.lastAttemptAt
      ? toUnixSeconds(effect.lastAttemptAt)
      : Math.floor(Date.now() / 1000);
    const transition = `ordtr_${crypto.randomUUID()}`;
    const nextVersion = current.version + 1;
    await d1.batch([
      d1
        .prepare(
          `UPDATE orders
           SET status='REQUIRES_ACTION', version=version+1, transition_key=?,
               provider_checkout_id=?, updated_at=?
           WHERE id=? AND status='PENDING' AND version=?`,
        )
        .bind(
          transition,
          result.providerCheckoutId,
          nowSec,
          current.id,
          current.version,
        ),
      d1
        .prepare(
          `INSERT INTO order_history
           (id, order_id, from_status, to_status, source, actor_id, detail, created_at)
           SELECT ?, id, 'PENDING', 'REQUIRES_ACTION', 'SYSTEM', NULL, ?, ?
           FROM orders
           WHERE id=? AND transition_key=? AND version=? AND status='REQUIRES_ACTION'`,
        )
        .bind(
          newId("ordh"),
          detail({
            checkoutProvider: result.provider,
            providerCheckoutId: result.providerCheckoutId,
          }),
          nowSec,
          current.id,
          transition,
          nextVersion,
        ),
    ]);
  } else if (
    current.status === "REQUIRES_ACTION" &&
    !current.providerCheckoutId
  ) {
    const d1 = await getD1Database();
    await d1
      .prepare(
        `UPDATE orders SET provider_checkout_id=?, updated_at=?
         WHERE id=? AND status='REQUIRES_ACTION' AND provider_checkout_id IS NULL`,
      )
      .bind(
        result.providerCheckoutId,
        Math.floor(Date.now() / 1000),
        current.id,
      )
      .run();
  }

  return JSON.stringify({
    provider: result.provider,
    providerCheckoutId: result.providerCheckoutId,
    checkoutUrl: result.checkoutUrl,
  });
}

async function handleCalendarCreate(
  effect: OrchestrationEffect,
  providers: CommerceSchedulingProviders,
): Promise<string> {
  const payload = bookingEffectPayloadSchema.parse(JSON.parse(effect.payload));
  const { booking, bookingType } = await getBookingContext(payload.bookingId);
  if (booking.status !== "CONFIRMED") {
    return JSON.stringify({
      skipped: true,
      reason: `booking_${booking.status.toLowerCase()}`,
    });
  }

  const result = await providers.calendar.createEvent({
    bookingId: booking.id,
    idempotencyKey: effect.idempotencyKey,
    calendarId: "decoded-hiring-primary",
    summary: bookingType.title,
    description: booking.notes ?? null,
    startAt: booking.startAt,
    endAt: booking.endAt,
    timezone: booking.timezone,
    attendees: [
      {
        email: booking.requesterEmail,
        displayName: booking.requesterName,
      },
    ],
  });

  return JSON.stringify(result);
}

async function handleCalendarUpdate(
  effect: OrchestrationEffect,
  providers: CommerceSchedulingProviders,
): Promise<string> {
  const payload = bookingEffectPayloadSchema.parse(JSON.parse(effect.payload));
  const { booking } = await getBookingContext(payload.bookingId);
  if (
    booking.status !== "CONFIRMED" ||
    (payload.bookingVersion != null && booking.version > payload.bookingVersion)
  ) {
    return JSON.stringify({
      skipped: true,
      reason:
        booking.status !== "CONFIRMED"
          ? `booking_${booking.status.toLowerCase()}`
          : "superseded_reschedule",
    });
  }
  const ref = await latestCalendarRef(booking.id);
  if (!ref) {
    throw new CommerceDomainError(
      "Calendar update is waiting for the original provider event reference.",
      "DEPENDENCY_NOT_READY",
    );
  }
  const result = await providers.calendar.updateEvent(ref, {
    bookingId: booking.id,
    idempotencyKey: effect.idempotencyKey,
    startAt: booking.startAt,
    endAt: booking.endAt,
    timezone: booking.timezone,
  });
  return JSON.stringify(result);
}

async function handleCalendarCancel(
  effect: OrchestrationEffect,
  providers: CommerceSchedulingProviders,
): Promise<string> {
  const payload = bookingEffectPayloadSchema.parse(JSON.parse(effect.payload));
  const { booking } = await getBookingContext(payload.bookingId);
  if (booking.status !== "CANCELLED") {
    return JSON.stringify({
      skipped: true,
      reason: `booking_${booking.status.toLowerCase()}`,
    });
  }
  const ref = await latestCalendarRef(booking.id);
  if (!ref) {
    // A booking may be cancelled before a calendar event was ever created.
    // Treat this as an honest no-op external side effect.
    return JSON.stringify({ skipped: true, reason: "no_calendar_event" });
  }
  await providers.calendar.cancelEvent(ref, {
    bookingId: booking.id,
    idempotencyKey: effect.idempotencyKey,
    reason: "Booking cancelled",
  });
  return JSON.stringify({ event: ref });
}

async function handleMail(
  effect: OrchestrationEffect,
  providers: CommerceSchedulingProviders,
): Promise<string> {
  const payload = bookingEffectPayloadSchema.parse(JSON.parse(effect.payload));
  const { booking, bookingType } = await getBookingContext(payload.bookingId);

  const isVersionStale =
    payload.bookingVersion != null && booking.version !== payload.bookingVersion;
  if (
    effect.effectType === "MAIL_CONFIRMATION" &&
    (booking.status !== "CONFIRMED" || isVersionStale)
  ) {
    return JSON.stringify({ skipped: true, reason: "stale_confirmation_message" });
  }
  if (
    effect.effectType === "MAIL_RESCHEDULE" &&
    (booking.status !== "CONFIRMED" || isVersionStale)
  ) {
    return JSON.stringify({ skipped: true, reason: "stale_reschedule_message" });
  }
  if (
    effect.effectType === "MAIL_CANCELLATION" &&
    (booking.status !== "CANCELLED" || isVersionStale)
  ) {
    return JSON.stringify({ skipped: true, reason: "stale_cancellation_message" });
  }
  if (effect.effectType === "MAIL_REMINDER" && booking.status !== "CONFIRMED") {
    return JSON.stringify({ skipped: true, reason: "booking_not_confirmed" });
  }

  const base = {
    bookingId: booking.id,
    idempotencyKey: effect.idempotencyKey,
    to: booking.requesterEmail,
    subject: "",
    html: "",
    text: "",
  };

  let result;
  switch (effect.effectType) {
    case "MAIL_CONFIRMATION":
      result = await providers.mailbox.sendConfirmation({
        ...base,
        subject: `Confirmed: ${bookingType.title}`,
        html: `<p>Your booking is confirmed for ${booking.startAt.toISOString()}.</p>`,
        text: `Your booking is confirmed for ${booking.startAt.toISOString()}.`,
      });
      break;
    case "MAIL_RESCHEDULE":
      result = await providers.mailbox.sendReschedule({
        ...base,
        subject: `Rescheduled: ${bookingType.title}`,
        html: `<p>Your booking is now scheduled for ${booking.startAt.toISOString()}.</p>`,
        text: `Your booking is now scheduled for ${booking.startAt.toISOString()}.`,
      });
      break;
    case "MAIL_CANCELLATION":
      result = await providers.mailbox.sendCancellation({
        ...base,
        subject: `Cancelled: ${bookingType.title}`,
        html: "<p>Your booking has been cancelled.</p>",
        text: "Your booking has been cancelled.",
      });
      break;
    case "MAIL_REMINDER":
      result = await providers.mailbox.sendReminder({
        ...base,
        subject: `Reminder: ${bookingType.title}`,
        html: `<p>Reminder: your booking is scheduled for ${booking.startAt.toISOString()}.</p>`,
        text: `Reminder: your booking is scheduled for ${booking.startAt.toISOString()}.`,
      });
      break;
    default:
      throw new CommerceDomainError(
        "Unsupported mailbox effect.",
        "INVALID_TRANSITION",
      );
  }

  return JSON.stringify(result);
}

async function executeEffect(
  effect: OrchestrationEffect,
  providers: CommerceSchedulingProviders,
): Promise<string | null> {
  switch (effect.effectType) {
    case "PAYMENT_CHECKOUT_CREATE":
      return handlePaymentCheckout(effect, providers);
    case "ORDER_FULFILL": {
      const payload = JSON.parse(effect.payload) as { orderId?: unknown };
      if (typeof payload.orderId !== "string") {
        throw new CommerceDomainError(
          "Invalid order fulfillment payload.",
          "DEPENDENCY_NOT_READY",
        );
      }
      const fulfilled = await fulfillPaidOrderFromOrchestration(
        payload.orderId,
        effect.lastAttemptAt ?? new Date(),
      );
      return JSON.stringify({ orderId: fulfilled.id, status: fulfilled.status });
    }
    case "CALENDAR_CREATE":
      return handleCalendarCreate(effect, providers);
    case "CALENDAR_UPDATE":
      return handleCalendarUpdate(effect, providers);
    case "CALENDAR_CANCEL":
      return handleCalendarCancel(effect, providers);
    case "MAIL_CONFIRMATION":
    case "MAIL_RESCHEDULE":
    case "MAIL_CANCELLATION":
    case "MAIL_REMINDER":
      return handleMail(effect, providers);
  }
}

function classifyFailure(
  error: unknown,
  attemptCount: number,
  now: Date,
): {
  status: Exclude<OrchestrationEffectStatus, "PENDING" | "PROCESSING" | "SUCCEEDED">;
  code: string;
  message: string;
  nextAttemptAt: Date | null;
} {
  if (error instanceof SchedulingProviderError) {
    if (
      error.code === "PROVIDER_NOT_CONFIGURED" ||
      error.code === "INVALID_CONFIGURATION"
    ) {
      return {
        status: "BLOCKED",
        code: error.code,
        message: error.message,
        nextAttemptAt: null,
      };
    }
    if (error.retryable) {
      const delaySeconds = Math.min(300, Math.max(5, 5 * 2 ** Math.min(attemptCount, 6)));
      return {
        status: "RETRYABLE_FAILURE",
        code: error.code,
        message: error.message,
        nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
      };
    }
    return {
      status: "TERMINAL_FAILURE",
      code: error.code,
      message: error.message,
      nextAttemptAt: null,
    };
  }

  if (
    error instanceof CommerceDomainError &&
    error.code === "DEPENDENCY_NOT_READY"
  ) {
    return {
      status: "RETRYABLE_FAILURE",
      code: error.code,
      message: error.message,
      nextAttemptAt: new Date(now.getTime() + 15_000),
    };
  }

  return {
    status: "RETRYABLE_FAILURE",
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : "Unexpected orchestration failure.",
    nextAttemptAt: new Date(now.getTime() + 30_000),
  };
}

async function finishEffect(
  effect: OrchestrationEffect,
  status: "SUCCEEDED",
  now: Date,
  providerRef: string | null,
): Promise<OrchestrationEffect>;
async function finishEffect(
  effect: OrchestrationEffect,
  status: Exclude<
    OrchestrationEffectStatus,
    "PENDING" | "PROCESSING" | "SUCCEEDED"
  >,
  now: Date,
  providerRef: null,
  errorCode: string,
  errorMessage: string,
  nextAttemptAt: Date | null,
): Promise<OrchestrationEffect>;
async function finishEffect(
  effect: OrchestrationEffect,
  status: OrchestrationEffectStatus,
  now: Date,
  providerRef: string | null,
  errorCode?: string,
  errorMessage?: string,
  nextAttemptAt?: Date | null,
): Promise<OrchestrationEffect> {
  if (!effect.claimToken) {
    throw new Error("Cannot finish an unclaimed orchestration effect.");
  }

  const d1 = await getD1Database();
  const nowSec = toUnixSeconds(now);
  const nextAttemptSec = nextAttemptAt ? toUnixSeconds(nextAttemptAt) : null;
  const action = status;
  const completionToken = `fxtr_${crypto.randomUUID()}`;
  await d1.batch([
    d1
      .prepare(
        `UPDATE orchestration_effects
         SET status=?,
             claim_token=NULL,
             transition_key=?,
             lease_expires_at=NULL,
             next_attempt_at=?,
             provider_ref=COALESCE(?, provider_ref),
             last_error_code=?,
             last_error_message=?,
             succeeded_at=?,
             updated_at=?
         WHERE id=? AND status='PROCESSING' AND claim_token=?`,
      )
      .bind(
        status,
        completionToken,
        nextAttemptSec,
        providerRef,
        errorCode ?? null,
        errorMessage ?? null,
        status === "SUCCEEDED" ? nowSec : null,
        nowSec,
        effect.id,
        effect.claimToken,
      ),
    d1
      .prepare(
        `INSERT INTO orchestration_history
         (id, effect_id, action, from_status, to_status, detail, created_at)
         SELECT ?, id, ?, 'PROCESSING', ?, ?, ?
         FROM orchestration_effects
         WHERE id=? AND status=? AND transition_key=? AND claim_token IS NULL`,
      )
      .bind(
        newId("fxh"),
        action,
        status,
        detail({
          providerRef,
          errorCode: errorCode ?? null,
          errorMessage: errorMessage ?? null,
          nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
        }),
        nowSec,
        effect.id,
        status,
        completionToken,
      ),
  ]);

  const finished = await getOrchestrationEffect(effect.id);
  if (
    !finished ||
    finished.status !== status ||
    finished.transitionKey !== completionToken
  ) {
    throw new CommerceDomainError(
      "Orchestration completion lost its lease ownership.",
      "CONCURRENT_MODIFICATION",
    );
  }
  return finished;
}

export async function listRunnableOrchestrationEffects(
  now: Date,
  limit = 25,
): Promise<OrchestrationEffect[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const db = await getDb();
  const candidates = await db
    .select()
    .from(orchestrationEffects)
    .where(
      and(
        or(
          inArray(orchestrationEffects.status, [
            "PENDING",
            "RETRYABLE_FAILURE",
          ]),
          and(
            eq(orchestrationEffects.status, "PROCESSING"),
            lte(orchestrationEffects.leaseExpiresAt, now),
          ),
        ),
        or(
          isNull(orchestrationEffects.nextAttemptAt),
          lte(orchestrationEffects.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(asc(orchestrationEffects.createdAt))
    .limit(boundedLimit);

  const dependencyIds = Array.from(
    new Set(
      candidates
        .map((effect) => effect.dependsOnEffectId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (dependencyIds.length === 0) return candidates;

  const dependencies = await db
    .select({
      id: orchestrationEffects.id,
      status: orchestrationEffects.status,
    })
    .from(orchestrationEffects)
    .where(inArray(orchestrationEffects.id, dependencyIds));
  const dependencyState = new Map(
    dependencies.map((effect) => [effect.id, effect.status] as const),
  );

  return candidates.filter(
    (effect) =>
      !effect.dependsOnEffectId ||
      dependencyState.get(effect.dependsOnEffectId) === "SUCCEEDED",
  );
}

export async function resumeConfiguredBlockedEffects(
  now: Date,
  providers: CommerceSchedulingProviders =
    UnconfiguredCommerceSchedulingProviders,
  limit = 100,
): Promise<number> {
  const db = await getDb();
  const blocked = await db
    .select()
    .from(orchestrationEffects)
    .where(eq(orchestrationEffects.status, "BLOCKED"))
    .orderBy(asc(orchestrationEffects.createdAt))
    .limit(Math.max(1, Math.min(limit, 500)));

  const statusCache = new Map<string, boolean>();
  let resumed = 0;
  const d1 = await getD1Database();
  const nowSec = toUnixSeconds(now);

  for (const effect of blocked) {
    let configured = statusCache.get(effect.providerKind);
    if (configured === undefined) {
      const status = await providerKindStatus(effect.providerKind, providers);
      configured = status.configured;
      statusCache.set(effect.providerKind, configured);
    }
    if (!configured) continue;

    const transition = `fxtr_${crypto.randomUUID()}`;
    await d1.batch([
      d1
        .prepare(
          `UPDATE orchestration_effects
           SET status='PENDING',
               transition_key=?,
               next_attempt_at=NULL,
               last_error_code=NULL,
               last_error_message=NULL,
               updated_at=?
           WHERE id=? AND status='BLOCKED'`,
        )
        .bind(transition, nowSec, effect.id),
      d1
        .prepare(
          `INSERT INTO orchestration_history
           (id, effect_id, action, from_status, to_status, detail, created_at)
           SELECT ?, id, 'RESET', 'BLOCKED', 'PENDING', ?, ?
           FROM orchestration_effects
           WHERE id=? AND status='PENDING' AND transition_key=?`,
        )
        .bind(
          newId("fxh"),
          detail({ reason: "provider_configured" }),
          nowSec,
          effect.id,
          transition,
        ),
    ]);

    const updated = await getOrchestrationEffect(effect.id);
    if (updated?.status === "PENDING" && updated.transitionKey === transition) {
      resumed += 1;
    }
  }
  return resumed;
}

export async function processDueOrchestrationEffects(
  params: {
    now: Date;
    limit?: number;
    leaseSeconds?: number;
  },
  providers: CommerceSchedulingProviders =
    UnconfiguredCommerceSchedulingProviders,
): Promise<OrchestrationEffect[]> {
  await resumeConfiguredBlockedEffects(
    params.now,
    providers,
    Math.max(100, (params.limit ?? 25) * 4),
  );
  const candidates = await listRunnableOrchestrationEffects(
    params.now,
    params.limit ?? 25,
  );
  const results: OrchestrationEffect[] = [];
  for (const effect of candidates) {
    results.push(
      await processOrchestrationEffect(
        {
          effectId: effect.id,
          now: params.now,
          leaseSeconds: params.leaseSeconds ?? 60,
        },
        providers,
      ),
    );
  }
  return results;
}

export async function processOrchestrationEffect(
  input: ProcessEffectInput,
  providers: CommerceSchedulingProviders =
    UnconfiguredCommerceSchedulingProviders,
): Promise<OrchestrationEffect> {
  const parsed = processEffectSchema.parse(input);
  const current = await getOrchestrationEffect(parsed.effectId);
  if (!current) {
    throw new CommerceDomainError(
      "Orchestration effect not found.",
      "DEPENDENCY_NOT_READY",
    );
  }
  if (current.status === "SUCCEEDED" || current.status === "TERMINAL_FAILURE") {
    return current;
  }

  if (current.status === "BLOCKED" && current.providerKind !== "internal") {
    const status = await providerStatus(current, providers);
    if (!status.configured) return current;
  }

  const claimed = await claimEffect(current, parsed);
  if (!claimed) return (await getOrchestrationEffect(current.id)) ?? current;

  try {
    const providerRef = await executeEffect(claimed, providers);
    return finishEffect(claimed, "SUCCEEDED", parsed.now, providerRef);
  } catch (error: unknown) {
    const failure = classifyFailure(error, claimed.attemptCount, parsed.now);
    return finishEffect(
      claimed,
      failure.status,
      parsed.now,
      null,
      failure.code,
      failure.message,
      failure.nextAttemptAt,
    );
  }
}
