// ============================================================================
// ORDER / PAYMENT BUSINESS TRUTH (Mission 08.5)
// ----------------------------------------------------------------------------
// Orders are provider-independent business truth. External payment evidence is
// accepted only through PaymentGateway verification boundaries. Provider ids
// are metadata; request/callback keys are internal idempotency identities.
//
// FULFILLED is never accepted from a provider. It is an internal transition
// after durable business fulfillment succeeds.
// ============================================================================

import { asc, eq } from "drizzle-orm";
import {
  bookings,
  offers,
  orderHistory,
  orders,
  paymentEvents,
  type Offer,
  type Order,
  type OrderHistory,
  type OrderStatus,
  type PaymentEvent,
  type PaymentState,
} from "@/lib/db";
import { getDb } from "@/lib/db";
import { getD1Database } from "@/lib/cloudflare/bindings";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { requireAdmin } from "@/lib/auth";
import type {
  NormalizePaymentStateResult,
  PaymentGateway,
  VerifyCallbackResult,
} from "@/features/scheduling";
import {
  createOrderSchema,
  manualPaymentSchema,
  verifiedCallbackApplicationSchema,
  verifiedWebhookApplicationSchema,
  type CreateOrderInput,
  type ManualPaymentInput,
  type VerifiedCallbackApplicationInput,
  type VerifiedWebhookApplicationInput,
} from "./order-schemas";

export type CommerceDomainErrorCode =
  | "ORDER_NOT_FOUND"
  | "OFFER_NOT_FOUND"
  | "OFFER_UNAVAILABLE"
  | "ORDER_NOT_ALLOWED"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_TRANSITION"
  | "PAYMENT_EVIDENCE_INVALID"
  | "PAYMENT_AMOUNT_MISMATCH"
  | "PAYMENT_CURRENCY_MISMATCH"
  | "AUTHORIZATION_REQUIRED"
  | "DEPENDENCY_NOT_READY"
  | "CONCURRENT_MODIFICATION";

export class CommerceDomainError extends Error {
  constructor(
    message: string,
    public readonly code: CommerceDomainErrorCode,
  ) {
    super(message);
    this.name = "CommerceDomainError";
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

function toUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

function detail(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

async function resolveAdminId(): Promise<string> {
  try {
    const session = await requireAdmin();
    return session.user.id;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.message.startsWith("Unauthorized:") ||
        error.message.startsWith("Forbidden:"))
    ) {
      throw new CommerceDomainError(
        "This commerce operation requires an authenticated admin session.",
        "AUTHORIZATION_REQUIRED",
      );
    }
    throw error;
  }
}

export async function getOrderById(id: string): Promise<Order | undefined> {
  const db = await getDb();
  return db.select().from(orders).where(eq(orders.id, id)).get();
}

export async function getOrderByRequestKey(
  requestKey: string,
): Promise<Order | undefined> {
  const db = await getDb();
  return db.select().from(orders).where(eq(orders.requestKey, requestKey)).get();
}

export async function getOrderHistory(orderId: string): Promise<OrderHistory[]> {
  const db = await getDb();
  return db
    .select()
    .from(orderHistory)
    .where(eq(orderHistory.orderId, orderId))
    .orderBy(asc(orderHistory.createdAt))
    .all();
}

export async function getPaymentEvents(orderId: string): Promise<PaymentEvent[]> {
  const db = await getDb();
  return db
    .select()
    .from(paymentEvents)
    .where(eq(paymentEvents.orderId, orderId))
    .orderBy(asc(paymentEvents.createdAt))
    .all();
}

export async function getOrderForAdmin(id: string): Promise<Order | undefined> {
  await resolveAdminId();
  return getOrderById(id);
}

function assertExistingOrderBinding(existing: Order, input: CreateOrderInput): Order {
  if (
    existing.offerId !== input.offerId ||
    (existing.bookingId ?? null) !== (input.bookingId ?? null) ||
    (existing.userId ?? null) !== (input.userId ?? null) ||
    existing.customerEmail !== input.customerEmail.toLowerCase()
  ) {
    throw new CommerceDomainError(
      "This requestKey is already bound to a different order request.",
      "IDEMPOTENCY_CONFLICT",
    );
  }
  return existing;
}

async function validateOrderTarget(
  offer: Offer,
  input: CreateOrderInput,
): Promise<void> {
  const db = await getDb();

  if (!offer.active) {
    throw new CommerceDomainError("Offer is not currently available.", "OFFER_UNAVAILABLE");
  }

  if (
    offer.accessMode !== "PAID_ONE_TIME" &&
    offer.accessMode !== "PAID_SESSION" &&
    offer.accessMode !== "MANUAL_INVOICE"
  ) {
    throw new CommerceDomainError(
      `Offer access mode ${offer.accessMode} does not create a payable order.`,
      "ORDER_NOT_ALLOWED",
    );
  }

  if (
    (offer.accessMode === "PAID_ONE_TIME" || offer.accessMode === "PAID_SESSION") &&
    (!offer.currency || offer.amountMinor == null || offer.amountMinor <= 0)
  ) {
    throw new CommerceDomainError(
      "Paid offer is missing authoritative price configuration.",
      "ORDER_NOT_ALLOWED",
    );
  }

  if (offer.kind === "COURSE") {
    if (!offer.courseId || !input.userId) {
      throw new CommerceDomainError(
        "Course orders require a linked course and authenticated learner identity.",
        "ORDER_NOT_ALLOWED",
      );
    }
    if (input.bookingId) {
      throw new CommerceDomainError(
        "Course orders cannot bind to a booking.",
        "ORDER_NOT_ALLOWED",
      );
    }
  }

  if (offer.accessMode === "PAID_SESSION") {
    if (!offer.bookingTypeId || !input.bookingId) {
      throw new CommerceDomainError(
        "Paid-session orders require a linked booking.",
        "ORDER_NOT_ALLOWED",
      );
    }
    const booking = await db
      .select({ id: bookings.id, bookingTypeId: bookings.bookingTypeId })
      .from(bookings)
      .where(eq(bookings.id, input.bookingId))
      .get();
    if (!booking || booking.bookingTypeId !== offer.bookingTypeId) {
      throw new CommerceDomainError(
        "Order booking does not match the Offer booking type.",
        "ORDER_NOT_ALLOWED",
      );
    }
  } else if (input.bookingId && offer.bookingTypeId) {
    const booking = await db
      .select({ id: bookings.id, bookingTypeId: bookings.bookingTypeId })
      .from(bookings)
      .where(eq(bookings.id, input.bookingId))
      .get();
    if (!booking || booking.bookingTypeId !== offer.bookingTypeId) {
      throw new CommerceDomainError(
        "Order booking does not match the Offer booking type.",
        "ORDER_NOT_ALLOWED",
      );
    }
  }
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const parsed = createOrderSchema.parse(input);
  const db = await getDb();

  const existing = await getOrderByRequestKey(parsed.requestKey);
  if (existing) return assertExistingOrderBinding(existing, parsed);

  const offer = await db.select().from(offers).where(eq(offers.id, parsed.offerId)).get();
  if (!offer) {
    throw new CommerceDomainError("Offer not found.", "OFFER_NOT_FOUND");
  }
  await validateOrderTarget(offer, parsed);

  const id = newId("order");
  const now = parsed.now;
  const values = {
    id,
    offerId: offer.id,
    bookingId: parsed.bookingId ?? null,
    userId: parsed.userId ?? null,
    requestKey: parsed.requestKey,
    customerEmail: parsed.customerEmail.toLowerCase(),
    quantity: parsed.quantity,
    amountMinor: offer.amountMinor,
    currency: offer.currency,
    status: "PENDING" as const,
    version: 1,
    transitionKey: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.batch([
      db.insert(orders).values(values),
      db.insert(orderHistory).values({
        id: newId("ordh"),
        orderId: id,
        fromStatus: null,
        toStatus: "PENDING",
        source: "SYSTEM",
        actorId: null,
        detail: detail({
          offerId: offer.id,
          accessMode: offer.accessMode,
          bookingId: parsed.bookingId ?? null,
          userId: parsed.userId ?? null,
        }),
        createdAt: now,
      }),
    ]);
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      const winner = await getOrderByRequestKey(parsed.requestKey);
      if (winner) return assertExistingOrderBinding(winner, parsed);
    }
    throw error;
  }

  const created = await getOrderById(id);
  if (!created) throw new Error("Order insert committed but could not be re-read.");
  return created;
}

function resolvePaymentTarget(
  current: OrderStatus,
  payment: PaymentState,
): OrderStatus {
  if (current === payment) return current;

  if (current === "FULFILLED" && payment === "PAID") {
    return "FULFILLED";
  }

  const allowed: Record<OrderStatus, readonly OrderStatus[]> = {
    PENDING: ["REQUIRES_ACTION", "PAID", "CANCELLED", "FAILED"],
    REQUIRES_ACTION: ["PAID", "CANCELLED", "FAILED"],
    PAID: ["REFUNDED"],
    FULFILLED: ["REFUNDED"],
    CANCELLED: [],
    FAILED: [],
    REFUNDED: [],
  };

  if (!allowed[current].includes(payment)) {
    throw new CommerceDomainError(
      `Invalid payment transition from ${current} to ${payment}.`,
      "INVALID_TRANSITION",
    );
  }
  return payment;
}

function assertPaymentEvidenceMatchesOrder(
  order: Order,
  evidence: {
    amountMinor?: number | null;
    currency?: string | null;
  },
): void {
  if (
    evidence.amountMinor != null &&
    order.amountMinor != null &&
    evidence.amountMinor !== order.amountMinor * order.quantity
  ) {
    throw new CommerceDomainError(
      "Verified payment amount does not match the order total.",
      "PAYMENT_AMOUNT_MISMATCH",
    );
  }
  if (
    evidence.currency &&
    order.currency &&
    evidence.currency.toUpperCase() !== order.currency.toUpperCase()
  ) {
    throw new CommerceDomainError(
      "Verified payment currency does not match the order currency.",
      "PAYMENT_CURRENCY_MISMATCH",
    );
  }
}

async function findPaymentEvent(callbackKey: string): Promise<PaymentEvent | undefined> {
  const db = await getDb();
  return db
    .select()
    .from(paymentEvents)
    .where(eq(paymentEvents.callbackKey, callbackKey))
    .get();
}

async function applyVerifiedPaymentObservation(params: {
  orderId: string;
  callbackKey: string;
  source: "CALLBACK" | "WEBHOOK";
  provider?: string | null;
  providerEventId?: string | null;
  providerCheckoutId?: string | null;
  providerPaymentId?: string | null;
  state: PaymentState;
  amountMinor?: number | null;
  currency?: string | null;
  now: Date;
}): Promise<Order> {
  const duplicate = await findPaymentEvent(params.callbackKey);
  if (duplicate) {
    if (duplicate.orderId !== params.orderId) {
      throw new CommerceDomainError(
        "Payment callback identity is already bound to another order.",
        "IDEMPOTENCY_CONFLICT",
      );
    }
    const current = await getOrderById(params.orderId);
    if (!current) throw new CommerceDomainError("Order not found.", "ORDER_NOT_FOUND");
    return current;
  }

  const order = await getOrderById(params.orderId);
  if (!order) throw new CommerceDomainError("Order not found.", "ORDER_NOT_FOUND");

  assertPaymentEvidenceMatchesOrder(order, params);
  const target = resolvePaymentTarget(order.status, params.state);

  const eventId = newId("payevt");
  const nowSec = toUnixSeconds(params.now);
  const transition = `ordtr_${crypto.randomUUID()}`;
  const targetVersion = order.version + (target === order.status ? 0 : 1);
  const d1 = await getD1Database();

  const insertEvent = d1
    .prepare(
      `INSERT INTO payment_events
        (id, order_id, callback_key, source, provider, provider_event_id,
         provider_checkout_id, provider_payment_id, state, amount_minor,
         currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      eventId,
      order.id,
      params.callbackKey,
      params.source,
      params.provider ?? null,
      params.providerEventId ?? null,
      params.providerCheckoutId ?? null,
      params.providerPaymentId ?? null,
      params.state,
      params.amountMinor ?? null,
      params.currency ?? null,
      nowSec,
    );

  if (target === order.status) {
    try {
      await d1.batch([insertEvent]);
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        const winner = await findPaymentEvent(params.callbackKey);
        if (winner?.orderId === order.id) return (await getOrderById(order.id))!;
      }
      throw error;
    }
    return order;
  }

  const paidAt = target === "PAID" ? nowSec : null;
  const cancelledAt = target === "CANCELLED" ? nowSec : null;
  const failedAt = target === "FAILED" ? nowSec : null;
  const refundedAt = target === "REFUNDED" ? nowSec : null;

  const updateOrder = d1
    .prepare(
      `UPDATE orders
       SET status = ?,
           version = version + 1,
           transition_key = ?,
           provider_checkout_id = COALESCE(?, provider_checkout_id),
           provider_payment_id = COALESCE(?, provider_payment_id),
           paid_at = COALESCE(?, paid_at),
           cancelled_at = COALESCE(?, cancelled_at),
           failed_at = COALESCE(?, failed_at),
           refunded_at = COALESCE(?, refunded_at),
           updated_at = ?
       WHERE id = ? AND status = ? AND version = ?`,
    )
    .bind(
      target,
      transition,
      params.providerCheckoutId ?? null,
      params.providerPaymentId ?? null,
      paidAt,
      cancelledAt,
      failedAt,
      refundedAt,
      nowSec,
      order.id,
      order.status,
      order.version,
    );

  const audit = d1
    .prepare(
      `INSERT INTO order_history
         (id, order_id, from_status, to_status, source, actor_id, detail, created_at)
       SELECT ?, id, ?, ?, ?, NULL, ?, ?
       FROM orders
       WHERE id = ? AND transition_key = ? AND version = ? AND status = ?`,
    )
    .bind(
      newId("ordh"),
      order.status,
      target,
      params.source === "WEBHOOK" ? "PAYMENT_WEBHOOK" : "PAYMENT_CALLBACK",
      detail({
        callbackKey: params.callbackKey,
        provider: params.provider ?? null,
        providerEventId: params.providerEventId ?? null,
        providerCheckoutId: params.providerCheckoutId ?? null,
        providerPaymentId: params.providerPaymentId ?? null,
      }),
      nowSec,
      order.id,
      transition,
      targetVersion,
      target,
    );

  const statements = [insertEvent, updateOrder, audit];

  if (target === "PAID") {
    const effectId = `fx_order_${order.id}_fulfill`;
    const effectKey = `order:${order.id}:fulfill`;
    statements.push(
      d1
        .prepare(
          `INSERT OR IGNORE INTO orchestration_effects
           (id, subject_type, subject_id, effect_type, provider_kind,
            idempotency_key, payload, status, attempt_count, created_at, updated_at)
           SELECT ?, 'ORDER', id, 'ORDER_FULFILL', 'internal', ?, ?, 'PENDING', 0, ?, ?
           FROM orders
           WHERE id = ? AND transition_key = ? AND version = ? AND status = 'PAID'`,
        )
        .bind(
          effectId,
          effectKey,
          detail({ orderId: order.id }),
          nowSec,
          nowSec,
          order.id,
          transition,
          targetVersion,
        ),
      d1
        .prepare(
          `INSERT OR IGNORE INTO orchestration_history
           (id, effect_id, action, from_status, to_status, detail, created_at)
           SELECT ?, id, 'ENQUEUED', NULL, 'PENDING', ?, ?
           FROM orchestration_effects WHERE id = ?`,
        )
        .bind(
          `fxh_${effectId}_enqueued`,
          detail({ reason: "payment_paid" }),
          nowSec,
          effectId,
        ),
    );
  }

  try {
    await d1.batch(statements);
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      const winner = await findPaymentEvent(params.callbackKey);
      if (winner?.orderId === order.id) return (await getOrderById(order.id))!;
    }
    throw error;
  }

  const updated = await getOrderById(order.id);
  if (
    !updated ||
    updated.status !== target ||
    updated.version !== targetVersion ||
    updated.transitionKey !== transition
  ) {
    throw new CommerceDomainError(
      "Order payment transition lost a concurrent modification.",
      "CONCURRENT_MODIFICATION",
    );
  }
  return updated;
}

export async function applyVerifiedPaymentCallback(
  gateway: PaymentGateway,
  input: VerifiedCallbackApplicationInput,
): Promise<Order> {
  const parsed = verifiedCallbackApplicationSchema.parse(input);
  const verified: VerifyCallbackResult = await gateway.verifyCallback({
    orderId: parsed.orderId,
    callbackPayload: parsed.callbackPayload,
  });
  if (!verified.verified) {
    throw new CommerceDomainError(
      "Payment callback was not verified.",
      "PAYMENT_EVIDENCE_INVALID",
    );
  }
  if (verified.orderId !== parsed.orderId) {
    throw new CommerceDomainError(
      "Verified callback order identity does not match the requested order.",
      "PAYMENT_EVIDENCE_INVALID",
    );
  }
  return applyVerifiedPaymentObservation({
    orderId: parsed.orderId,
    callbackKey: parsed.callbackKey,
    source: "CALLBACK",
    provider: parsed.provider ?? null,
    providerEventId: verified.providerEventId ?? null,
    providerCheckoutId: verified.providerCheckoutId ?? null,
    providerPaymentId: verified.providerPaymentId ?? null,
    state: verified.state,
    amountMinor: verified.amountMinor ?? null,
    currency: verified.currency ?? null,
    now: parsed.now,
  });
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function applyVerifiedPaymentWebhook(
  gateway: PaymentGateway,
  input: VerifiedWebhookApplicationInput,
): Promise<Order> {
  const parsed = verifiedWebhookApplicationSchema.parse(input);

  // Mandatory security gate: no normalization/persistence before signature
  // verification succeeds.
  const signature = await gateway.verifyWebhookSignature({
    rawBody: parsed.rawBody,
    signature: parsed.signature,
    headers: parsed.headers,
  });
  if (!signature.valid) {
    throw new CommerceDomainError(
      "Payment webhook signature verification failed.",
      "PAYMENT_EVIDENCE_INVALID",
    );
  }

  const normalized: NormalizePaymentStateResult =
    await gateway.normalizePaymentState({
      orderId: parsed.orderId,
      providerState: parsed.providerState,
      amountMinor: parsed.amountMinor ?? null,
      currency: parsed.currency ?? null,
    });

  if (normalized.orderId !== parsed.orderId) {
    throw new CommerceDomainError(
      "Normalized payment order identity does not match the requested order.",
      "PAYMENT_EVIDENCE_INVALID",
    );
  }

  const bodyHash = await sha256Hex(parsed.rawBody);
  const callbackKey = signature.providerEventId
    ? `webhook:${parsed.provider ?? "provider"}:${signature.providerEventId}`
    : `webhook:sha256:${bodyHash}`;

  return applyVerifiedPaymentObservation({
    orderId: parsed.orderId,
    callbackKey,
    source: "WEBHOOK",
    provider: parsed.provider ?? null,
    providerEventId: signature.providerEventId ?? null,
    state: normalized.state,
    amountMinor: normalized.amountMinor ?? null,
    currency: normalized.currency ?? null,
    now: parsed.now,
  });
}

async function recordManualPaymentAsActor(
  input: ManualPaymentInput,
  actorId: string,
): Promise<Order> {
  const parsed = manualPaymentSchema.parse(input);
  const db = await getDb();
  const order = await getOrderById(parsed.orderId);
  if (!order) throw new CommerceDomainError("Order not found.", "ORDER_NOT_FOUND");
  if (order.version !== parsed.expectedVersion) {
    throw new CommerceDomainError(
      "Order version changed before manual payment could be recorded.",
      "CONCURRENT_MODIFICATION",
    );
  }
  const offer = await db.select().from(offers).where(eq(offers.id, order.offerId)).get();
  if (!offer || offer.accessMode !== "MANUAL_INVOICE") {
    throw new CommerceDomainError(
      "Only MANUAL_INVOICE orders may be marked paid manually.",
      "ORDER_NOT_ALLOWED",
    );
  }
  if (order.status === "PAID" || order.status === "FULFILLED") return order;
  if (order.status !== "PENDING" && order.status !== "REQUIRES_ACTION") {
    throw new CommerceDomainError(
      `Cannot record manual payment from ${order.status}.`,
      "INVALID_TRANSITION",
    );
  }

  const d1 = await getD1Database();
  const nowSec = toUnixSeconds(parsed.now);
  const transition = `ordtr_${crypto.randomUUID()}`;
  const targetVersion = order.version + 1;
  const effectId = `fx_order_${order.id}_fulfill`;

  await d1.batch([
    d1
      .prepare(
        `UPDATE orders
         SET status='PAID', version=version+1, transition_key=?,
             paid_at=?, updated_at=?
         WHERE id=? AND status=? AND version=?`,
      )
      .bind(
        transition,
        nowSec,
        nowSec,
        order.id,
        order.status,
        order.version,
      ),
    d1
      .prepare(
        `INSERT INTO order_history
         (id, order_id, from_status, to_status, source, actor_id, detail, created_at)
         SELECT ?, id, ?, 'PAID', 'ADMIN', ?, ?, ?
         FROM orders
         WHERE id=? AND transition_key=? AND version=? AND status='PAID'`,
      )
      .bind(
        newId("ordh"),
        order.status,
        actorId,
        detail({ note: parsed.note ?? null }),
        nowSec,
        order.id,
        transition,
        targetVersion,
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO orchestration_effects
         (id, subject_type, subject_id, effect_type, provider_kind,
          idempotency_key, payload, status, attempt_count, created_at, updated_at)
         SELECT ?, 'ORDER', id, 'ORDER_FULFILL', 'internal', ?, ?, 'PENDING', 0, ?, ?
         FROM orders
         WHERE id=? AND transition_key=? AND version=? AND status='PAID'`,
      )
      .bind(
        effectId,
        `order:${order.id}:fulfill`,
        detail({ orderId: order.id }),
        nowSec,
        nowSec,
        order.id,
        transition,
        targetVersion,
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO orchestration_history
         (id, effect_id, action, from_status, to_status, detail, created_at)
         SELECT ?, id, 'ENQUEUED', NULL, 'PENDING', ?, ?
         FROM orchestration_effects WHERE id=?`,
      )
      .bind(
        `fxh_${effectId}_enqueued`,
        detail({ reason: "manual_payment_paid" }),
        nowSec,
        effectId,
      ),
  ]);

  const updated = await getOrderById(order.id);
  if (
    !updated ||
    updated.status !== "PAID" ||
    updated.version !== targetVersion ||
    updated.transitionKey !== transition
  ) {
    throw new CommerceDomainError(
      "Manual payment transition lost a concurrent modification.",
      "CONCURRENT_MODIFICATION",
    );
  }
  return updated;
}

export async function recordManualPaymentForAdmin(
  input: ManualPaymentInput,
): Promise<Order> {
  const actorId = await resolveAdminId();
  return recordManualPaymentAsActor(input, actorId);
}

/**
 * Internal fulfillment transition used only by the durable orchestration
 * runner. Course access and order FULFILLED commit atomically. Booking-backed
 * orders can only fulfill after their booking is CONFIRMED.
 */
export async function fulfillPaidOrderFromOrchestration(
  orderId: string,
  now: Date,
): Promise<Order> {
  const db = await getDb();
  const order = await getOrderById(orderId);
  if (!order) throw new CommerceDomainError("Order not found.", "ORDER_NOT_FOUND");
  if (order.status === "FULFILLED") return order;
  if (order.status !== "PAID") {
    throw new CommerceDomainError(
      `Order must be PAID before fulfillment; found ${order.status}.`,
      "DEPENDENCY_NOT_READY",
    );
  }

  const offer = await db.select().from(offers).where(eq(offers.id, order.offerId)).get();
  if (!offer) throw new CommerceDomainError("Offer not found.", "OFFER_NOT_FOUND");

  if (offer.bookingTypeId) {
    if (!order.bookingId) {
      throw new CommerceDomainError(
        "Booking-backed order has no booking identity.",
        "DEPENDENCY_NOT_READY",
      );
    }
    const booking = await db
      .select({ status: bookings.status, bookingTypeId: bookings.bookingTypeId })
      .from(bookings)
      .where(eq(bookings.id, order.bookingId))
      .get();
    if (
      !booking ||
      booking.bookingTypeId !== offer.bookingTypeId ||
      booking.status !== "CONFIRMED"
    ) {
      throw new CommerceDomainError(
        "Booking-backed order is waiting for a confirmed matching booking.",
        "DEPENDENCY_NOT_READY",
      );
    }
  }

  const d1 = await getD1Database();
  const nowSec = toUnixSeconds(now);
  const transition = `ordtr_${crypto.randomUUID()}`;
  const targetVersion = order.version + 1;
  const statements = [];

  if (offer.kind === "COURSE") {
    if (!offer.courseId || !order.userId) {
      throw new CommerceDomainError(
        "Course order is missing learner/course identity.",
        "DEPENDENCY_NOT_READY",
      );
    }
    statements.push(
      d1
        .prepare(
          `INSERT INTO enrollments
           (id, user_id, course_id, status, access_source, enrolled_at, completed_at)
           VALUES (?, ?, ?, 'active', ?, ?, NULL)
           ON CONFLICT(user_id, course_id) DO UPDATE SET
             status='active',
             access_source=excluded.access_source,
             completed_at=NULL`,
        )
        .bind(
          `enroll_order_${order.id}`,
          order.userId,
          offer.courseId,
          `order:${order.id}`,
          nowSec,
        ),
    );
  }

  statements.push(
    d1
      .prepare(
        `UPDATE orders
         SET status='FULFILLED', version=version+1, transition_key=?,
             fulfilled_at=?, updated_at=?
         WHERE id=? AND status='PAID' AND version=?`,
      )
      .bind(
        transition,
        nowSec,
        nowSec,
        order.id,
        order.version,
      ),
    d1
      .prepare(
        `INSERT INTO order_history
         (id, order_id, from_status, to_status, source, actor_id, detail, created_at)
         SELECT ?, id, 'PAID', 'FULFILLED', 'SYSTEM', NULL, ?, ?
         FROM orders
         WHERE id=? AND transition_key=? AND version=? AND status='FULFILLED'`,
      )
      .bind(
        newId("ordh"),
        detail({ offerKind: offer.kind, offerId: offer.id }),
        nowSec,
        order.id,
        transition,
        targetVersion,
      ),
  );

  await d1.batch(statements);

  const updated = await getOrderById(order.id);
  if (
    !updated ||
    updated.status !== "FULFILLED" ||
    updated.version !== targetVersion ||
    updated.transitionKey !== transition
  ) {
    throw new CommerceDomainError(
      "Order fulfillment lost a concurrent modification.",
      "CONCURRENT_MODIFICATION",
    );
  }
  return updated;
}

const commerceTestApi = {
  getOrder: getOrderById,
  getHistory: getOrderHistory,
  getPaymentEvents,
  recordManualPayment: (input: ManualPaymentInput, actorId = "test-admin") =>
    recordManualPaymentAsActor(input, actorId),
};

export const __commerceTestOnly =
  process.env.DH_COMMERCE_TEST_SEAM === "1" ? commerceTestApi : undefined;
