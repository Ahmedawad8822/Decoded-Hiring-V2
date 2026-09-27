import { asc, desc, inArray } from "drizzle-orm";

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
  type BookingHistory,
  type OrderHistory,
  type PaymentEvent,
} from "@/lib/db";
import { getDb } from "@/lib/db";
import {
  UnconfiguredCommerceSchedulingProviders,
  type ProviderRuntimeStatus,
} from "@/features/scheduling/providers";

export type CommerceAdminProviderStatus = ProviderRuntimeStatus & {
  statusError?: string | null;
};

function groupBy<T, K extends string>(
  rows: T[],
  keyOf: (row: T) => K,
): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const row of rows) {
    const key = keyOf(row);
    (result[key] ??= []).push(row);
  }
  return result;
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
        return await provider.getStatus();
      } catch {
        return {
          kind,
          provider: null,
          configured: false,
          capabilities: [],
          statusError: "Provider status is unavailable.",
        } satisfies CommerceAdminProviderStatus;
      }
    }),
  );
}

export async function getCommerceAdminDashboard() {
  await requireAdmin();
  const db = await getDb();

  const [
    offerRows,
    bookingTypeRows,
    windowRows,
    bookingRows,
    orderRows,
    effectRows,
    courseRows,
    providerStatuses,
  ] = await Promise.all([
    db.select().from(offers).orderBy(desc(offers.updatedAt)).limit(200),
    db.select().from(bookingTypes).orderBy(asc(bookingTypes.title)).limit(200),
    db
      .select()
      .from(bookingAvailabilityWindows)
      .orderBy(
        asc(bookingAvailabilityWindows.bookingTypeId),
        asc(bookingAvailabilityWindows.weekday),
        asc(bookingAvailabilityWindows.startMinute),
      )
      .limit(1000),
    db.select().from(bookings).orderBy(desc(bookings.startAt)).limit(200),
    db.select().from(orders).orderBy(desc(orders.createdAt)).limit(200),
    db
      .select()
      .from(orchestrationEffects)
      .orderBy(desc(orchestrationEffects.updatedAt))
      .limit(200),
    db
      .select({
        id: courses.id,
        title: courses.title,
        slug: courses.slug,
        status: courses.status,
      })
      .from(courses)
      .orderBy(asc(courses.title))
      .limit(300),
    readProviderStatuses(),
  ]);

  const bookingIds = bookingRows.map((row) => row.id);
  const orderIds = orderRows.map((row) => row.id);

  const [bookingHistoryRows, orderHistoryRows, paymentEventRows] =
    await Promise.all([
      bookingIds.length
        ? db
            .select()
            .from(bookingHistory)
            .where(inArray(bookingHistory.bookingId, bookingIds))
            .orderBy(asc(bookingHistory.createdAt))
        : Promise.resolve([] as BookingHistory[]),
      orderIds.length
        ? db
            .select()
            .from(orderHistory)
            .where(inArray(orderHistory.orderId, orderIds))
            .orderBy(asc(orderHistory.createdAt))
        : Promise.resolve([] as OrderHistory[]),
      orderIds.length
        ? db
            .select()
            .from(paymentEvents)
            .where(inArray(paymentEvents.orderId, orderIds))
            .orderBy(asc(paymentEvents.createdAt))
        : Promise.resolve([] as PaymentEvent[]),
    ]);

  const now = new Date();
  const approvals = bookingRows.filter(
    (row) =>
      row.status === "REQUESTED" || row.status === "PENDING_APPROVAL",
  );
  const upcoming = bookingRows.filter(
    (row) => row.status === "CONFIRMED" && row.endAt >= now,
  );

  return {
    generatedAt: now,
    summary: {
      activeOffers: offerRows.filter((row) => row.active).length,
      activeBookingTypes: bookingTypeRows.filter((row) => row.active).length,
      approvalQueue: approvals.length,
      upcomingBookings: upcoming.length,
      openOrders: orderRows.filter((row) =>
        ["PENDING", "REQUIRES_ACTION", "PAID"].includes(row.status),
      ).length,
      blockedEffects: effectRows.filter((row) => row.status === "BLOCKED").length,
    },
    offers: offerRows,
    bookingTypes: bookingTypeRows,
    windows: windowRows,
    bookings: bookingRows,
    bookingHistoryByBooking: groupBy(
      bookingHistoryRows,
      (row) => row.bookingId,
    ),
    orders: orderRows,
    orderHistoryByOrder: groupBy(orderHistoryRows, (row) => row.orderId),
    paymentEventsByOrder: groupBy(paymentEventRows, (row) => row.orderId),
    orchestrationEffects: effectRows,
    providers: providerStatuses,
    courses: courseRows,
  };
}
