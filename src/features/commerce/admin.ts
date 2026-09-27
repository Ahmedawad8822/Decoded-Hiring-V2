import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
} from "drizzle-orm";

import { requireAdmin } from "@/lib/auth";
import {
  bookingAvailabilityWindows,
  bookingHistory,
  bookings,
  bookingTypes,
  courses,
  offers,
  orchestrationEffects,
  orderHistory,
  orders,
  paymentEvents,
} from "@/lib/db";
import { getDb } from "@/lib/db";
import {
  UnconfiguredCommerceSchedulingProviders,
  type ProviderRuntimeStatus,
} from "@/features/scheduling/providers";
import type {
  BoundedAdminList,
  CommerceAdminAvailabilityWindow,
  CommerceAdminBooking,
  CommerceAdminBookingAudit,
  CommerceAdminBookingHistory,
  CommerceAdminBookingType,
  CommerceAdminCourse,
  CommerceAdminDashboard,
  CommerceAdminOffer,
  CommerceAdminOrder,
  CommerceAdminOrderAudit,
  CommerceAdminOrderHistory,
  CommerceAdminOrchestrationEffect,
  CommerceAdminPaymentEvent,
  CommerceAdminProviderStatus,
} from "./admin-model";

type AdminGuard = () => Promise<unknown>;

export type CommerceAdminReadLimits = {
  config: number;
  windows: number;
  queue: number;
  orders: number;
  effects: number;
  courses: number;
  audit: number;
};

const DEFAULT_LIMITS: CommerceAdminReadLimits = {
  config: 500,
  windows: 2_000,
  queue: 100,
  orders: 100,
  effects: 100,
  courses: 500,
  audit: 200,
};

function bounded<T>(items: T[], total: number, limit: number): BoundedAdminList<T> {
  return {
    items,
    total,
    limit,
    truncated: total > items.length,
  };
}

async function countRows(
  where:
    | ReturnType<typeof eq>
    | ReturnType<typeof and>
    | ReturnType<typeof gte>
    | ReturnType<typeof inArray>
    | undefined,
  table:
    | typeof offers
    | typeof bookingTypes
    | typeof bookingAvailabilityWindows
    | typeof bookings
    | typeof orders
    | typeof orchestrationEffects
    | typeof courses
    | typeof bookingHistory
    | typeof orderHistory
    | typeof paymentEvents,
): Promise<number> {
  const db = await getDb();
  const query = db.select({ value: count() }).from(table);
  const row = where ? await query.where(where).get() : await query.get();
  return Number(row?.value ?? 0);
}

async function readProviderStatuses(): Promise<CommerceAdminProviderStatus[]> {
  const providers = UnconfiguredCommerceSchedulingProviders;
  const entries = [
    ["payment", providers.payment],
    ["calendar", providers.calendar],
    ["mailbox", providers.mailbox],
    ["meeting", providers.meeting],
  ] as const;

  return Promise.all(
    entries.map(async ([kind, provider]) => {
      try {
        const status: ProviderRuntimeStatus = await provider.getStatus();
        return {
          kind: status.kind,
          provider: status.provider,
          configured: status.configured,
          capabilities: [...status.capabilities],
        };
      } catch {
        return {
          kind,
          provider: null,
          configured: false,
          capabilities: [],
          statusError: "Provider status is unavailable.",
        };
      }
    }),
  );
}

function mapOffer(row: typeof offers.$inferSelect): CommerceAdminOffer {
  return {
    id: row.id,
    kind: row.kind,
    courseId: row.courseId,
    bookingTypeId: row.bookingTypeId,
    title: row.title,
    slug: row.slug,
    accessMode: row.accessMode,
    currency: row.currency,
    amountMinor: row.amountMinor,
    alternativeCtaLabel: row.alternativeCtaLabel,
    alternativeCtaUrl: row.alternativeCtaUrl,
    active: row.active,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapBookingType(
  row: typeof bookingTypes.$inferSelect,
): CommerceAdminBookingType {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    durationMinutes: row.durationMinutes,
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
    minimumNoticeMinutes: row.minimumNoticeMinutes,
    bookingHorizonDays: row.bookingHorizonDays,
    timezone: row.timezone,
    confirmationPolicy: row.confirmationPolicy,
    accessMode: row.accessMode,
    meetingMethod: row.meetingMethod,
    attendeeLimit: row.attendeeLimit,
    active: row.active,
  };
}

function mapWindow(
  row: typeof bookingAvailabilityWindows.$inferSelect,
): CommerceAdminAvailabilityWindow {
  return {
    id: row.id,
    bookingTypeId: row.bookingTypeId,
    weekday: row.weekday,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
  };
}

const bookingProjection = {
  id: bookings.id,
  bookingTypeId: bookings.bookingTypeId,
  requesterName: bookings.requesterName,
  requesterEmail: bookings.requesterEmail,
  startAt: bookings.startAt,
  endAt: bookings.endAt,
  status: bookings.status,
  version: bookings.version,
};

function mapBooking(
  row: Awaited<ReturnType<typeof readBookingRows>>[number],
): CommerceAdminBooking {
  return {
    ...row,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
  };
}

async function readBookingRows(
  status: "REQUESTED" | "PENDING_APPROVAL" | "CONFIRMED",
  limit: number,
  now?: Date,
) {
  const db = await getDb();
  const predicate =
    status === "CONFIRMED" && now
      ? and(eq(bookings.status, status), gte(bookings.endAt, now))
      : eq(bookings.status, status);
  return db
    .select(bookingProjection)
    .from(bookings)
    .where(predicate)
    .orderBy(
      status === "REQUESTED" ? desc(bookings.createdAt) : asc(bookings.startAt),
    )
.limit(limit);
}

export async function getCommerceAdminDashboardWithGuard(
  guard: AdminGuard,
  limitOverrides: Partial<CommerceAdminReadLimits> = {},
): Promise<CommerceAdminDashboard> {
  await guard();
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const db = await getDb();
  const now = new Date();

  const [
    offerRows,
    offerTotal,
    activeOfferTotal,
    bookingTypeRows,
    bookingTypeTotal,
    activeBookingTypeTotal,
    windowRows,
    windowTotal,
    requestedRows,
    requestedTotal,
    approvalRows,
    approvalTotal,
    upcomingRows,
    upcomingTotal,
    orderRows,
    orderTotal,
    openOrderTotal,
    effectRows,
    effectTotal,
    blockedEffectTotal,
    courseRows,
    courseTotal,
    providerStatuses,
    linkedOfferRows,
  ] = await Promise.all([
    db.select().from(offers).orderBy(desc(offers.updatedAt)).limit(limits.config),
    countRows(undefined, offers),
    countRows(eq(offers.active, true), offers),
    db.select().from(bookingTypes).orderBy(asc(bookingTypes.title)).limit(limits.config),
    countRows(undefined, bookingTypes),
    countRows(eq(bookingTypes.active, true), bookingTypes),
    db
      .select()
      .from(bookingAvailabilityWindows)
      .orderBy(
        asc(bookingAvailabilityWindows.bookingTypeId),
        asc(bookingAvailabilityWindows.weekday),
        asc(bookingAvailabilityWindows.startMinute),
      )
      .limit(limits.windows),
    countRows(undefined, bookingAvailabilityWindows),
    readBookingRows("REQUESTED", limits.queue),
    countRows(eq(bookings.status, "REQUESTED"), bookings),
    readBookingRows("PENDING_APPROVAL", limits.queue),
    countRows(eq(bookings.status, "PENDING_APPROVAL"), bookings),
    readBookingRows("CONFIRMED", limits.queue, now),
    countRows(and(eq(bookings.status, "CONFIRMED"), gte(bookings.endAt, now)), bookings),
    db
      .select({
        id: orders.id,
        offerId: orders.offerId,
        accessMode: orders.accessMode,
        customerEmail: orders.customerEmail,
        amountMinor: orders.amountMinor,
        currency: orders.currency,
        status: orders.status,
        version: orders.version,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(limits.orders),
    countRows(undefined, orders),
    countRows(inArray(orders.status, ["PENDING", "REQUIRES_ACTION", "PAID"]), orders),
    db
      .select({
        id: orchestrationEffects.id,
        subjectType: orchestrationEffects.subjectType,
        subjectId: orchestrationEffects.subjectId,
        effectType: orchestrationEffects.effectType,
        providerKind: orchestrationEffects.providerKind,
        status: orchestrationEffects.status,
        attemptCount: orchestrationEffects.attemptCount,
        lastErrorCode: orchestrationEffects.lastErrorCode,
        lastErrorMessage: orchestrationEffects.lastErrorMessage,
        updatedAt: orchestrationEffects.updatedAt,
      })
      .from(orchestrationEffects)
      .orderBy(desc(orchestrationEffects.updatedAt))
      .limit(limits.effects),
    countRows(undefined, orchestrationEffects),
    countRows(eq(orchestrationEffects.status, "BLOCKED"), orchestrationEffects),
    db
      .select({
        id: courses.id,
        title: courses.title,
        slug: courses.slug,
        status: courses.status,
      })
      .from(courses)
      .orderBy(asc(courses.title))
      .limit(limits.courses),
    countRows(undefined, courses),
    readProviderStatuses(),
    db
      .select({ bookingTypeId: offers.bookingTypeId })
      .from(offers)
      .where(isNotNull(offers.bookingTypeId)),
  ]);

  const orderItems: CommerceAdminOrder[] = orderRows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
  const effectItems: CommerceAdminOrchestrationEffect[] = effectRows.map((row) => ({
    ...row,
    updatedAt: row.updatedAt.toISOString(),
  }));
  const courseItems: CommerceAdminCourse[] = courseRows;

  return {
    generatedAt: now.toISOString(),
    summary: {
      activeOffers: activeOfferTotal,
      activeBookingTypes: activeBookingTypeTotal,
      approvalQueue: approvalTotal,
      requestedBookings: requestedTotal,
      upcomingBookings: upcomingTotal,
      openOrders: openOrderTotal,
      blockedEffects: blockedEffectTotal,
    },
    offers: bounded(offerRows.map(mapOffer), offerTotal, limits.config),
    bookingTypes: bounded(
      bookingTypeRows.map(mapBookingType),
      bookingTypeTotal,
      limits.config,
    ),
    windows: bounded(windowRows.map(mapWindow), windowTotal, limits.windows),
    requestedBookings: bounded(
      requestedRows.map(mapBooking),
      requestedTotal,
      limits.queue,
    ),
    approvalQueue: bounded(
      approvalRows.map(mapBooking),
      approvalTotal,
      limits.queue,
    ),
    upcomingBookings: bounded(
      upcomingRows.map(mapBooking),
      upcomingTotal,
      limits.queue,
    ),
    orders: bounded(orderItems, orderTotal, limits.orders),
    orchestrationEffects: bounded(effectItems, effectTotal, limits.effects),
    providers: providerStatuses,
    courses: bounded(courseItems, courseTotal, limits.courses),
    linkedOfferBookingTypeIds: linkedOfferRows
      .map((row) => row.bookingTypeId)
      .filter((id): id is string => Boolean(id)),
  };
}

export async function getCommerceAdminDashboard(): Promise<CommerceAdminDashboard> {
  return getCommerceAdminDashboardWithGuard(requireAdmin);
}

export async function getBookingAuditWithGuard(
  bookingId: string,
  guard: AdminGuard,
  limit = DEFAULT_LIMITS.audit,
): Promise<CommerceAdminBookingAudit> {
  await guard();
  const db = await getDb();
  const where = eq(bookingHistory.bookingId, bookingId);
  const [rows, total] = await Promise.all([
    db
      .select({
        id: bookingHistory.id,
        bookingId: bookingHistory.bookingId,
        action: bookingHistory.action,
        fromStatus: bookingHistory.fromStatus,
        toStatus: bookingHistory.toStatus,
        actorId: bookingHistory.actorId,
        createdAt: bookingHistory.createdAt,
      })
      .from(bookingHistory)
      .where(where)
      .orderBy(desc(bookingHistory.createdAt))
      .limit(limit),
    countRows(where, bookingHistory),
  ]);
  const items: CommerceAdminBookingHistory[] = rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
  return { bookingId, history: bounded(items, total, limit) };
}

export async function getBookingAuditForAdmin(
  bookingId: string,
): Promise<CommerceAdminBookingAudit> {
  return getBookingAuditWithGuard(bookingId, requireAdmin);
}

export async function getOrderAuditWithGuard(
  orderId: string,
  guard: AdminGuard,
  limit = DEFAULT_LIMITS.audit,
): Promise<CommerceAdminOrderAudit> {
  await guard();
  const db = await getDb();
  const historyWhere = eq(orderHistory.orderId, orderId);
  const eventWhere = eq(paymentEvents.orderId, orderId);
  const [historyRows, historyTotal, eventRows, eventTotal] = await Promise.all([
    db
      .select({
        id: orderHistory.id,
        orderId: orderHistory.orderId,
        fromStatus: orderHistory.fromStatus,
        toStatus: orderHistory.toStatus,
        source: orderHistory.source,
        createdAt: orderHistory.createdAt,
      })
      .from(orderHistory)
      .where(historyWhere)
      .orderBy(desc(orderHistory.createdAt))
      .limit(limit),
    countRows(historyWhere, orderHistory),
    db
      .select({
        id: paymentEvents.id,
        orderId: paymentEvents.orderId,
        source: paymentEvents.source,
        provider: paymentEvents.provider,
        state: paymentEvents.state,
        createdAt: paymentEvents.createdAt,
      })
      .from(paymentEvents)
      .where(eventWhere)
      .orderBy(desc(paymentEvents.createdAt))
      .limit(limit),
    countRows(eventWhere, paymentEvents),
  ]);

  const historyItems: CommerceAdminOrderHistory[] = historyRows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
  const eventItems: CommerceAdminPaymentEvent[] = eventRows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));

  return {
    orderId,
    history: bounded(historyItems, historyTotal, AUDIT_LIMIT),
    paymentEvents: bounded(eventItems, eventTotal, AUDIT_LIMIT),
  };
}

export async function getOrderAuditForAdmin(
  orderId: string,
): Promise<CommerceAdminOrderAudit> {
  return getOrderAuditWithGuard(orderId, requireAdmin);
}
