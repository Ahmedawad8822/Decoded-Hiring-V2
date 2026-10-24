import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
} from "drizzle-orm";

import { requireAdmin } from "@/lib/auth";
import { getBusinessEventSummary } from "@/features/analytics/service";
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
  CommerceAdminPageRequest,
  CommerceAdminPaymentEvent,
  CommerceAdminProviderStatus,
} from "./admin-model";

type AdminGuard = () => Promise<unknown>;

const CONFIG_LIMIT = 50;
const QUEUE_LIMIT = 50;
const ORDER_LIMIT = 50;
const EFFECT_LIMIT = 50;
const COURSE_LIMIT = 100;
const AUDIT_LIMIT = 200;

function requestedPage(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(10_000, Math.floor(value ?? 1)));
}

function clampedPage(value: number | undefined, total: number, limit: number): number {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return Math.min(requestedPage(value), totalPages);
}

function bounded<T>(
  items: T[],
  total: number,
  limit: number,
  page = 1,
): BoundedAdminList<T> {
  return {
    items,
    total,
    limit,
    page,
    totalPages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
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
  bookingTypeTitle: bookingTypes.title,
  confirmationPolicy: bookingTypes.confirmationPolicy,
  requesterName: bookings.requesterName,
  requesterEmail: bookings.requesterEmail,
  startAt: bookings.startAt,
  endAt: bookings.endAt,
  status: bookings.status,
  version: bookings.version,
};

async function readBookingRows(
  status: "REQUESTED" | "PENDING_APPROVAL" | "CONFIRMED",
  page: number,
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
    .innerJoin(bookingTypes, eq(bookings.bookingTypeId, bookingTypes.id))
    .where(predicate)
    .orderBy(
      status === "REQUESTED" ? desc(bookings.createdAt) : asc(bookings.startAt),
    )
    .limit(QUEUE_LIMIT)
    .offset((page - 1) * QUEUE_LIMIT);
}

function mapBooking(
  row: Awaited<ReturnType<typeof readBookingRows>>[number],
): CommerceAdminBooking {
  return {
    ...row,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
  };
}

export async function getCommerceAdminDashboardWithGuard(
  guard: AdminGuard,
  request: CommerceAdminPageRequest = {},
): Promise<CommerceAdminDashboard> {
  await guard();
  const db = await getDb();
  const now = new Date();

  const [
    offerTotal,
    activeOfferTotal,
    bookingTypeTotal,
    activeBookingTypeTotal,
    requestedTotal,
    approvalTotal,
    upcomingTotal,
    orderTotal,
    openOrderTotal,
    effectTotal,
    blockedEffectTotal,
    courseTotal,
    providerStatuses,
    observability,
  ] = await Promise.all([
    countRows(undefined, offers),
    countRows(eq(offers.active, true), offers),
    countRows(undefined, bookingTypes),
    countRows(eq(bookingTypes.active, true), bookingTypes),
    countRows(eq(bookings.status, "REQUESTED"), bookings),
    countRows(eq(bookings.status, "PENDING_APPROVAL"), bookings),
    countRows(
      and(eq(bookings.status, "CONFIRMED"), gte(bookings.endAt, now)),
      bookings,
    ),
    countRows(undefined, orders),
    countRows(
      inArray(orders.status, ["PENDING", "REQUIRES_ACTION", "PAID"]),
      orders,
    ),
    countRows(undefined, orchestrationEffects),
    countRows(eq(orchestrationEffects.status, "BLOCKED"), orchestrationEffects),
    countRows(undefined, courses),
    readProviderStatuses(),
    getBusinessEventSummary({ windowDays: 30, now }),
  ]);

  const pages = {
    offers: clampedPage(request.offers, offerTotal, CONFIG_LIMIT),
    bookingTypes: clampedPage(
      request.bookingTypes,
      bookingTypeTotal,
      CONFIG_LIMIT,
    ),
    requested: clampedPage(request.requested, requestedTotal, QUEUE_LIMIT),
    approvals: clampedPage(request.approvals, approvalTotal, QUEUE_LIMIT),
    upcoming: clampedPage(request.upcoming, upcomingTotal, QUEUE_LIMIT),
    orders: clampedPage(request.orders, orderTotal, ORDER_LIMIT),
    effects: clampedPage(request.effects, effectTotal, EFFECT_LIMIT),
    courses: clampedPage(request.courses, courseTotal, COURSE_LIMIT),
  };

  const [
    offerRows,
    bookingTypeRows,
    requestedRows,
    approvalRows,
    upcomingRows,
    orderRows,
    effectRows,
    courseRows,
  ] = await Promise.all([
    db
      .select()
      .from(offers)
      .orderBy(desc(offers.updatedAt))
      .limit(CONFIG_LIMIT)
      .offset((pages.offers - 1) * CONFIG_LIMIT),
    db
      .select()
      .from(bookingTypes)
      .orderBy(asc(bookingTypes.title))
      .limit(CONFIG_LIMIT)
      .offset((pages.bookingTypes - 1) * CONFIG_LIMIT),
    readBookingRows("REQUESTED", pages.requested),
    readBookingRows("PENDING_APPROVAL", pages.approvals),
    readBookingRows("CONFIRMED", pages.upcoming, now),
    db
      .select({
        id: orders.id,
        offerId: orders.offerId,
        offerTitle: offers.title,
        accessMode: orders.accessMode,
        customerEmail: orders.customerEmail,
        amountMinor: orders.amountMinor,
        currency: orders.currency,
        status: orders.status,
        version: orders.version,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(offers, eq(orders.offerId, offers.id))
      .orderBy(desc(orders.createdAt))
      .limit(ORDER_LIMIT)
      .offset((pages.orders - 1) * ORDER_LIMIT),
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
      .limit(EFFECT_LIMIT)
      .offset((pages.effects - 1) * EFFECT_LIMIT),
    db
      .select({
        id: courses.id,
        title: courses.title,
        slug: courses.slug,
        status: courses.status,
      })
      .from(courses)
      .orderBy(asc(courses.title))
      .limit(COURSE_LIMIT)
      .offset((pages.courses - 1) * COURSE_LIMIT),
  ]);

  const bookingTypeIds = bookingTypeRows.map((row) => row.id);
  const [windowRows, linkedOfferRows] = bookingTypeIds.length
    ? await Promise.all([
        db
          .select()
          .from(bookingAvailabilityWindows)
          .where(inArray(bookingAvailabilityWindows.bookingTypeId, bookingTypeIds))
          .orderBy(
            asc(bookingAvailabilityWindows.bookingTypeId),
            asc(bookingAvailabilityWindows.weekday),
            asc(bookingAvailabilityWindows.startMinute),
          ),
        db
          .select({ bookingTypeId: offers.bookingTypeId })
          .from(offers)
          .where(inArray(offers.bookingTypeId, bookingTypeIds)),
      ])
    : [[], []];

  const orderItems: CommerceAdminOrder[] = orderRows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
  const effectItems: CommerceAdminOrchestrationEffect[] = effectRows.map(
    (row) => ({
      ...row,
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
  const courseItems: CommerceAdminCourse[] = courseRows;
  const windowItems = windowRows.map(mapWindow);

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
    offers: bounded(
      offerRows.map(mapOffer),
      offerTotal,
      CONFIG_LIMIT,
      pages.offers,
    ),
    bookingTypes: bounded(
      bookingTypeRows.map(mapBookingType),
      bookingTypeTotal,
      CONFIG_LIMIT,
      pages.bookingTypes,
    ),
    windows: bounded(
      windowItems,
      windowItems.length,
      Math.max(1, windowItems.length),
      1,
    ),
    requestedBookings: bounded(
      requestedRows.map(mapBooking),
      requestedTotal,
      QUEUE_LIMIT,
      pages.requested,
    ),
    approvalQueue: bounded(
      approvalRows.map(mapBooking),
      approvalTotal,
      QUEUE_LIMIT,
      pages.approvals,
    ),
    upcomingBookings: bounded(
      upcomingRows.map(mapBooking),
      upcomingTotal,
      QUEUE_LIMIT,
      pages.upcoming,
    ),
    orders: bounded(orderItems, orderTotal, ORDER_LIMIT, pages.orders),
    orchestrationEffects: bounded(
      effectItems,
      effectTotal,
      EFFECT_LIMIT,
      pages.effects,
    ),
    providers: providerStatuses,
    courses: bounded(courseItems, courseTotal, COURSE_LIMIT, pages.courses),
    linkedOfferBookingTypeIds: linkedOfferRows
      .map((row) => row.bookingTypeId)
      .filter((id): id is string => Boolean(id)),
    observability,
  };
}

export async function getCommerceAdminDashboard(
  request: CommerceAdminPageRequest = {},
): Promise<CommerceAdminDashboard> {
  return getCommerceAdminDashboardWithGuard(requireAdmin, request);
}

export async function getBookingAuditWithGuard(
  bookingId: string,
  guard: AdminGuard,
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
      .limit(AUDIT_LIMIT),
    countRows(where, bookingHistory),
  ]);
  const items: CommerceAdminBookingHistory[] = rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
  return {
    bookingId,
    history: bounded(items, total, AUDIT_LIMIT, 1),
  };
}

export async function getBookingAuditForAdmin(
  bookingId: string,
): Promise<CommerceAdminBookingAudit> {
  return getBookingAuditWithGuard(bookingId, requireAdmin);
}

export async function getOrderAuditWithGuard(
  orderId: string,
  guard: AdminGuard,
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
      .limit(AUDIT_LIMIT),
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
      .limit(AUDIT_LIMIT),
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
    history: bounded(historyItems, historyTotal, AUDIT_LIMIT, 1),
    paymentEvents: bounded(eventItems, eventTotal, AUDIT_LIMIT, 1),
  };
}

export async function getOrderAuditForAdmin(
  orderId: string,
): Promise<CommerceAdminOrderAudit> {
  return getOrderAuditWithGuard(orderId, requireAdmin);
}
