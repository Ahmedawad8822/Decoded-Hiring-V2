"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  bookingDecisionAdminAction,
  createAvailabilityWindowAdminAction,
  createBookingTypeAdminAction,
  createOfferAdminAction,
  deleteAvailabilityWindowAdminAction,
  recordManualPaymentAdminAction,
  updateBookingTypeAdminAction,
  updateOfferAdminAction,
} from "@/features/commerce/admin-actions";

type OfferRow = {
  id: string;
  kind: "COURSE" | "COACHING" | "WORKSHOP" | "PRODUCT";
  courseId: string | null;
  bookingTypeId: string | null;
  title: string;
  slug: string;
  accessMode:
    | "FREE"
    | "PAID_ONE_TIME"
    | "PAID_SESSION"
    | "MANUAL_INVOICE"
    | "PAYMENT_DISABLED"
    | "COMING_SOON";
  currency: string | null;
  amountMinor: number | null;
  alternativeCtaLabel: string | null;
  alternativeCtaUrl: string | null;
  active: boolean;
  updatedAt: string;
};

type BookingTypeRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  bookingHorizonDays: number;
  timezone: string;
  confirmationPolicy: "AUTO_CONFIRM" | "AHMED_APPROVAL" | "REQUEST_ONLY";
  accessMode: "FREE" | "PAID_SESSION" | "MANUAL_INVOICE" | "PAYMENT_DISABLED";
  meetingMethod:
    | "GOOGLE_MEET"
    | "EXTERNAL_LINK"
    | "PHONE"
    | "IN_PERSON"
    | "TO_BE_CONFIRMED";
  attendeeLimit: number;
  active: boolean;
};

type WindowRow = {
  id: string;
  bookingTypeId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

type BookingRow = {
  id: string;
  bookingTypeId: string;
  requesterName: string;
  requesterEmail: string;
  requesterPhone: string | null;
  notes: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  status:
    | "REQUESTED"
    | "PENDING_APPROVAL"
    | "CONFIRMED"
    | "COMPLETED"
    | "CANCELLED"
    | "DECLINED";
  version: number;
  createdAt: string;
};

type BookingHistoryRow = {
  id: string;
  bookingId: string;
  action: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string | null;
  detail: string | null;
  createdAt: string;
};

type OrderRow = {
  id: string;
  offerId: string;
  offerKind: string;
  accessMode: string;
  bookingId: string | null;
  userId: string | null;
  customerEmail: string;
  quantity: number;
  amountMinor: number | null;
  currency: string | null;
  status: string;
  version: number;
  providerCheckoutId: string | null;
  providerPaymentId: string | null;
  createdAt: string;
  updatedAt: string;
};

type OrderHistoryRow = {
  id: string;
  orderId: string;
  fromStatus: string | null;
  toStatus: string;
  source: string;
  actorId: string | null;
  detail: string | null;
  createdAt: string;
};

type PaymentEventRow = {
  id: string;
  orderId: string;
  source: string;
  provider: string | null;
  providerEventId: string | null;
  state: string;
  amountMinor: number | null;
  currency: string | null;
  createdAt: string;
};

type ProviderRow = {
  kind: "payment" | "calendar" | "mailbox" | "meeting";
  provider: string | null;
  configured: boolean;
  capabilities: string[];
  statusError?: string | null;
};

type EffectRow = {
  id: string;
  subjectType: string;
  subjectId: string;
  effectType: string;
  providerKind: string;
  status: string;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
};

type CourseRow = {
  id: string;
  title: string;
  slug: string;
  status: string;
};

type Snapshot = {
  generatedAt: string;
  summary: {
    activeOffers: number;
    activeBookingTypes: number;
    approvalQueue: number;
    requestedBookings: number;
    upcomingBookings: number;
    openOrders: number;
    blockedEffects: number;
  };
  offers: OfferRow[];
  bookingTypes: BookingTypeRow[];
  windows: WindowRow[];
  bookings: BookingRow[];
  bookingHistoryByBooking: Record<string, BookingHistoryRow[]>;
  orders: OrderRow[];
  orderHistoryByOrder: Record<string, OrderHistoryRow[]>;
  paymentEventsByOrder: Record<string, PaymentEventRow[]>;
  orchestrationEffects: EffectRow[];
  providers: ProviderRow[];
  courses: CourseRow[];
};

type ActionResult = { ok: boolean; error?: string };

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-surface)",
  background: "var(--paper-bright)",
  padding: "20px 22px",
};

const fieldStyle: React.CSSProperties = {
  padding: "9px 11px",
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  fontSize: 13,
  width: "100%",
};

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: 5,
  fontSize: 12,
  fontWeight: 600,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  margin: 0,
};

const ACCESS_MODES = [
  "FREE",
  "PAID_ONE_TIME",
  "PAID_SESSION",
  "MANUAL_INVOICE",
  "PAYMENT_DISABLED",
  "COMING_SOON",
] as const;

const BOOKING_ACCESS_MODES = [
  "FREE",
  "PAID_SESSION",
  "MANUAL_INVOICE",
  "PAYMENT_DISABLED",
] as const;

const CONFIRMATION_POLICIES = [
  "AUTO_CONFIRM",
  "AHMED_APPROVAL",
  "REQUEST_ONLY",
] as const;

const MEETING_METHODS = [
  "TO_BE_CONFIRMED",
  "GOOGLE_MEET",
  "EXTERNAL_LINK",
  "PHONE",
  "IN_PERSON",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function nullable(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function integer(value: FormDataEntryValue | null, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function minutesFromClock(value: FormDataEntryValue | null): number {
  const [hours, minutes] = String(value ?? "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function clockFromMinutes(value: number): string {
  const hours = Math.floor(value / 60).toString().padStart(2, "0");
  const minutes = (value % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function money(amountMinor: number | null, currency: string | null): string {
  if (amountMinor == null || !currency) return "Not priced";
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function StatusPill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: "1px solid var(--line)",
        borderRadius: 999,
        padding: "3px 8px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: ".02em",
      }}
    >
      {children}
    </span>
  );
}

function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      style={{
        padding: "10px 14px",
        borderRadius: 8,
        background: "var(--coral-soft, #f5d6cd)",
        color: "#7c2d12",
        border: "1px solid rgba(235,116,94,.4)",
        fontSize: 13,
      }}
    >
      {error}
    </div>
  );
}

export function CommerceAdminClient({ initial }: { initial: Snapshot }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newOfferKind, setNewOfferKind] =
    useState<OfferRow["kind"]>("COACHING");
  const [newOfferMode, setNewOfferMode] =
    useState<OfferRow["accessMode"]>("FREE");

  const bookingTypeById = useMemo(
    () => new Map(initial.bookingTypes.map((row) => [row.id, row])),
    [initial.bookingTypes],
  );
  const offerById = useMemo(
    () => new Map(initial.offers.map((row) => [row.id, row])),
    [initial.offers],
  );
  const windowsByType = useMemo(() => {
    const map = new Map<string, WindowRow[]>();
    for (const row of initial.windows) {
      const list = map.get(row.bookingTypeId) ?? [];
      list.push(row);
      map.set(row.bookingTypeId, list);
    }
    return map;
  }, [initial.windows]);

  const approvals = initial.bookings.filter(
    (row) => row.status === "REQUESTED" || row.status === "PENDING_APPROVAL",
  );
  const upcoming = initial.bookings.filter(
    (row) => row.status === "CONFIRMED" && new Date(row.endAt) >= new Date(),
  );

  const run = async (key: string, fn: () => Promise<ActionResult>) => {
    setBusy(key);
    setError(null);
    try {
      const result = await fn();
      if (!result.ok) {
        setError(result.error || "Action failed.");
        return;
      }
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  const submitCreateOffer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amountRaw = nullable(form.get("amountMinor"));
    const kind = newOfferKind;
    const courseId = kind === "COURSE" ? nullable(form.get("courseId")) : null;
    const bookingTypeId =
      kind === "COACHING" || kind === "WORKSHOP"
        ? nullable(form.get("bookingTypeId"))
        : null;

    await run("create-offer", () =>
      createOfferAdminAction({
        kind,
        courseId,
        bookingTypeId,
        title: String(form.get("title") ?? "").trim(),
        slug: String(form.get("slug") ?? "").trim(),
        accessMode: newOfferMode,
        currency: nullable(form.get("currency")),
        amountMinor: amountRaw == null ? null : integer(form.get("amountMinor")),
        alternativeCtaLabel: nullable(form.get("alternativeCtaLabel")),
        alternativeCtaUrl: nullable(form.get("alternativeCtaUrl")),
        active: true,
      }),
    );
  };

  const submitEditOffer = async (
    event: React.FormEvent<HTMLFormElement>,
    offer: OfferRow,
  ) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amountRaw = nullable(form.get("amountMinor"));
    await run(`offer-${offer.id}`, () =>
      updateOfferAdminAction({
        id: offer.id,
        title: String(form.get("title") ?? "").trim(),
        slug: String(form.get("slug") ?? "").trim(),
        accessMode: String(form.get("accessMode") ?? offer.accessMode),
        currency: nullable(form.get("currency")),
        amountMinor: amountRaw == null ? null : integer(form.get("amountMinor")),
        alternativeCtaLabel: nullable(form.get("alternativeCtaLabel")),
        alternativeCtaUrl: nullable(form.get("alternativeCtaUrl")),
        active: form.get("active") === "on",
      }),
    );
  };

  const submitCreateBookingType = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run("create-booking-type", () =>
      createBookingTypeAdminAction({
        slug: String(form.get("slug") ?? "").trim(),
        title: String(form.get("title") ?? "").trim(),
        description: nullable(form.get("description")),
        durationMinutes: integer(form.get("durationMinutes"), 60),
        bufferBeforeMinutes: integer(form.get("bufferBeforeMinutes"), 0),
        bufferAfterMinutes: integer(form.get("bufferAfterMinutes"), 0),
        minimumNoticeMinutes: integer(form.get("minimumNoticeMinutes"), 0),
        bookingHorizonDays: integer(form.get("bookingHorizonDays"), 30),
        timezone: String(form.get("timezone") ?? "Africa/Cairo").trim(),
        confirmationPolicy: String(
          form.get("confirmationPolicy") ?? "AHMED_APPROVAL",
        ),
        accessMode: String(form.get("accessMode") ?? "FREE"),
        meetingMethod: String(form.get("meetingMethod") ?? "TO_BE_CONFIRMED"),
        attendeeLimit: integer(form.get("attendeeLimit"), 1),
      }),
    );
  };

  const submitEditBookingType = async (
    event: React.FormEvent<HTMLFormElement>,
    bookingType: BookingTypeRow,
  ) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(`booking-type-${bookingType.id}`, () =>
      updateBookingTypeAdminAction({
        id: bookingType.id,
        slug: String(form.get("slug") ?? "").trim(),
        title: String(form.get("title") ?? "").trim(),
        description: nullable(form.get("description")),
        durationMinutes: integer(form.get("durationMinutes"), 60),
        bufferBeforeMinutes: integer(form.get("bufferBeforeMinutes"), 0),
        bufferAfterMinutes: integer(form.get("bufferAfterMinutes"), 0),
        minimumNoticeMinutes: integer(form.get("minimumNoticeMinutes"), 0),
        bookingHorizonDays: integer(form.get("bookingHorizonDays"), 30),
        timezone: String(form.get("timezone") ?? "Africa/Cairo").trim(),
        confirmationPolicy: String(form.get("confirmationPolicy")),
        accessMode: String(form.get("accessMode")),
        meetingMethod: String(form.get("meetingMethod")),
        attendeeLimit: integer(form.get("attendeeLimit"), 1),
        active: form.get("active") === "on",
      }),
    );
  };

  const submitWindow = async (
    event: React.FormEvent<HTMLFormElement>,
    bookingTypeId: string,
  ) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(`window-${bookingTypeId}`, () =>
      createAvailabilityWindowAdminAction({
        bookingTypeId,
        weekday: integer(form.get("weekday")),
        startMinute: minutesFromClock(form.get("start")),
        endMinute: minutesFromClock(form.get("end")),
      }),
    );
  };

  const decision = (
    booking: BookingRow,
    action: "approve" | "decline" | "cancel" | "complete",
  ) =>
    run(`${action}-${booking.id}`, () =>
      bookingDecisionAdminAction({
        action,
        bookingId: booking.id,
        expectedVersion: booking.version,
      }),
    );

  const recordManualPayment = (order: OrderRow) =>
    run(`pay-${order.id}`, () =>
      recordManualPaymentAdminAction({
        orderId: order.id,
        expectedVersion: order.version,
        note: "Recorded from Studio Scheduling & Commerce.",
      }),
    );

  return (
    <div style={{ display: "grid", gap: 28 }}>
      <div>
        <h1 className="a-h1" style={{ marginBottom: 6 }}>
          Scheduling & Commerce
        </h1>
        <p className="muted" style={{ margin: 0, maxWidth: 760 }}>
          One operational view of Offers, booking policy, approvals, payment truth,
          provider readiness and audit history. External providers remain
          fail-closed until separately configured.
        </p>
      </div>

      <ErrorBanner error={error} />

      <section
        aria-label="Commerce summary"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
        }}
      >
        {[
          ["Active Offers", initial.summary.activeOffers],
          ["Booking Types", initial.summary.activeBookingTypes],
          ["Approval Queue", initial.summary.approvalQueue],
          ["Requests", initial.summary.requestedBookings],
          ["Upcoming", initial.summary.upcomingBookings],
          ["Open Orders", initial.summary.openOrders],
          ["Blocked Effects", initial.summary.blockedEffects],
        ].map(([label, value]) => (
          <div key={String(label)} style={cardStyle}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700 }}>
              {label}
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>
              {value}
            </div>
          </div>
        ))}
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <div>
          <h2 style={sectionTitleStyle}>Provider readiness</h2>
          <p className="muted" style={{ fontSize: 12.5, margin: "5px 0 0" }}>
            Status only. This screen cannot activate credentials or providers.
          </p>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: 12,
          }}
        >
          {initial.providers.map((provider) => (
            <div key={provider.kind} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <b style={{ textTransform: "capitalize" }}>{provider.kind}</b>
                <StatusPill>{provider.configured ? "CONFIGURED" : "NOT CONFIGURED"}</StatusPill>
              </div>
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
                {provider.provider || "Provider-neutral adapter"}
              </p>
              {provider.statusError && (
                <p style={{ fontSize: 12, color: "#7c2d12" }}>{provider.statusError}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <div>
          <h2 style={sectionTitleStyle}>Requests & approval queue</h2>
          <p className="muted" style={{ fontSize: 12.5, margin: "5px 0 0" }}>
            Only server-authorized lifecycle transitions are available here.
          </p>
        </div>
        {approvals.length === 0 ? (
          <div style={cardStyle} className="muted">
            No booking is waiting for a decision.
          </div>
        ) : (
          approvals.map((booking) => {
            const bookingType = bookingTypeById.get(booking.bookingTypeId);
            return (
              <div key={booking.id} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <b>{booking.requesterName}</b>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {bookingType?.title || booking.bookingTypeId} · {dateTime(booking.startAt)}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {booking.requesterEmail}
                    </div>
                  </div>
                  <StatusPill>{booking.status}</StatusPill>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                  {booking.status === "PENDING_APPROVAL" && (
                    <button
                      type="button"
                      className="btn primary small"
                      disabled={busy === `approve-${booking.id}`}
                      onClick={() => decision(booking, "approve")}
                    >
                      Approve
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn danger small"
                    disabled={busy === `decline-${booking.id}`}
                    onClick={() => decision(booking, "decline")}
                  >
                    Decline
                  </button>
                </div>
                <BookingAudit
                  rows={initial.bookingHistoryByBooking[booking.id] ?? []}
                />
              </div>
            );
          })
        )}
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2 style={sectionTitleStyle}>Upcoming bookings</h2>
        {upcoming.length === 0 ? (
          <div style={cardStyle} className="muted">
            No confirmed upcoming bookings.
          </div>
        ) : (
          upcoming.map((booking) => {
            const bookingType = bookingTypeById.get(booking.bookingTypeId);
            return (
              <div key={booking.id} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <b>{booking.requesterName}</b>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {bookingType?.title || booking.bookingTypeId} · {dateTime(booking.startAt)}
                    </div>
                  </div>
                  <StatusPill>{booking.status}</StatusPill>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn secondary small"
                    disabled={busy === `complete-${booking.id}`}
                    onClick={() => decision(booking, "complete")}
                  >
                    Mark complete
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    disabled={busy === `cancel-${booking.id}`}
                    onClick={() => decision(booking, "cancel")}
                  >
                    Cancel
                  </button>
                </div>
                <BookingAudit
                  rows={initial.bookingHistoryByBooking[booking.id] ?? []}
                />
              </div>
            );
          })
        )}
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2 style={sectionTitleStyle}>Offers</h2>
        <details style={cardStyle}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Create Offer</summary>
          <form
            onSubmit={submitCreateOffer}
            style={{ display: "grid", gap: 12, marginTop: 16 }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
              <label style={labelStyle}>
                Kind
                <select
                  name="kind"
                  value={newOfferKind}
                  onChange={(event) =>
                    setNewOfferKind(event.target.value as OfferRow["kind"])
                  }
                  style={fieldStyle}
                >
                  <option value="COURSE">Course</option>
                  <option value="COACHING">Coaching</option>
                  <option value="WORKSHOP">Workshop</option>
                  <option value="PRODUCT">Product</option>
                </select>
              </label>
              <label style={labelStyle}>
                Title
                <input name="title" required minLength={3} style={fieldStyle} />
              </label>
              <label style={labelStyle}>
                Slug
                <input
                  name="slug"
                  required
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  style={fieldStyle}
                />
              </label>
              <label style={labelStyle}>
                Access mode
                <select
                  name="accessMode"
                  value={newOfferMode}
                  onChange={(event) =>
                    setNewOfferMode(event.target.value as OfferRow["accessMode"])
                  }
                  style={fieldStyle}
                >
                  {ACCESS_MODES.map((mode) => (
                    <option key={mode} value={mode}>{mode}</option>
                  ))}
                </select>
              </label>
              {newOfferKind === "COURSE" && (
                <label style={labelStyle}>
                  Course
                  <select name="courseId" required style={fieldStyle}>
                    <option value="">Choose course</option>
                    {initial.courses.map((course) => (
                      <option key={course.id} value={course.id}>
                        {course.title} ({course.status})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(newOfferKind === "COACHING" || newOfferKind === "WORKSHOP") && (
                <label style={labelStyle}>
                  Booking type
                  <select name="bookingTypeId" style={fieldStyle}>
                    <option value="">Lead-first only / no booking type</option>
                    {initial.bookingTypes.map((row) => (
                      <option key={row.id} value={row.id}>{row.title}</option>
                    ))}
                  </select>
                </label>
              )}
              <label style={labelStyle}>
                Currency
                <input name="currency" placeholder="USD" maxLength={3} style={fieldStyle} />
              </label>
              <label style={labelStyle}>
                Amount minor units
                <input name="amountMinor" type="number" min={0} step={1} style={fieldStyle} />
              </label>
              <label style={labelStyle}>
                Alternative CTA label
                <input name="alternativeCtaLabel" style={fieldStyle} />
              </label>
              <label style={labelStyle}>
                Alternative CTA URL
                <input name="alternativeCtaUrl" style={fieldStyle} />
              </label>
            </div>
            <button
              className="btn primary small"
              type="submit"
              disabled={busy === "create-offer"}
              style={{ justifySelf: "start" }}
            >
              Create Offer
            </button>
          </form>
        </details>

        {initial.offers.length === 0 && (
          <div style={cardStyle} className="muted">No Offers configured.</div>
        )}

        {initial.offers.map((offer) => (
          <details key={offer.id} style={cardStyle}>
            <summary style={{ cursor: "pointer" }}>
              <span style={{ fontWeight: 700 }}>{offer.title}</span>{" "}
              <span className="muted" style={{ fontSize: 12 }}>
                {offer.kind} · {offer.accessMode} · {offer.active ? "ACTIVE" : "INACTIVE"}
              </span>
            </summary>
            <form
              onSubmit={(event) => submitEditOffer(event, offer)}
              style={{ display: "grid", gap: 12, marginTop: 16 }}
            >
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Linked entity is intentionally fixed here. Create a new Offer if the
                commercial identity itself needs to change.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                <label style={labelStyle}>
                  Title
                  <input name="title" defaultValue={offer.title} required style={fieldStyle} />
                </label>
                <label style={labelStyle}>
                  Slug
                  <input name="slug" defaultValue={offer.slug} required style={fieldStyle} />
                </label>
                <label style={labelStyle}>
                  Access mode
                  <select name="accessMode" defaultValue={offer.accessMode} style={fieldStyle}>
                    {ACCESS_MODES.map((mode) => (
                      <option key={mode} value={mode}>{mode}</option>
                    ))}
                  </select>
                </label>
                <label style={labelStyle}>
                  Currency
                  <input name="currency" defaultValue={offer.currency ?? ""} maxLength={3} style={fieldStyle} />
                </label>
                <label style={labelStyle}>
                  Amount minor units
                  <input name="amountMinor" type="number" min={0} step={1} defaultValue={offer.amountMinor ?? ""} style={fieldStyle} />
                </label>
                <label style={labelStyle}>
                  Alternative CTA label
                  <input name="alternativeCtaLabel" defaultValue={offer.alternativeCtaLabel ?? ""} style={fieldStyle} />
                </label>
                <label style={labelStyle}>
                  Alternative CTA URL
                  <input name="alternativeCtaUrl" defaultValue={offer.alternativeCtaUrl ?? ""} style={fieldStyle} />
                </label>
              </div>
              <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
                <input name="active" type="checkbox" defaultChecked={offer.active} />
                Active
              </label>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  className="btn secondary small"
                  type="submit"
                  disabled={busy === `offer-${offer.id}`}
                >
                  Save Offer
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {money(offer.amountMinor, offer.currency)}
                </span>
              </div>
            </form>
          </details>
        ))}
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2 style={sectionTitleStyle}>Booking types & availability</h2>
        <details style={cardStyle}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>
            Create booking type
          </summary>
          <form
            onSubmit={submitCreateBookingType}
            style={{ display: "grid", gap: 12, marginTop: 16 }}
          >
            <BookingTypeFields />
            <button
              className="btn primary small"
              type="submit"
              disabled={busy === "create-booking-type"}
              style={{ justifySelf: "start" }}
            >
              Create booking type
            </button>
          </form>
        </details>

        {initial.bookingTypes.map((bookingType) => (
          <details key={bookingType.id} style={cardStyle}>
            <summary style={{ cursor: "pointer" }}>
              <span style={{ fontWeight: 700 }}>{bookingType.title}</span>{" "}
              <span className="muted" style={{ fontSize: 12 }}>
                {bookingType.confirmationPolicy} · {bookingType.accessMode} ·{" "}
                {bookingType.active ? "ACTIVE" : "INACTIVE"}
              </span>
            </summary>

            <form
              onSubmit={(event) => submitEditBookingType(event, bookingType)}
              style={{ display: "grid", gap: 12, marginTop: 16 }}
            >
              <BookingTypeFields value={bookingType} />
              <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
                <input name="active" type="checkbox" defaultChecked={bookingType.active} />
                Active
              </label>
              <button
                className="btn secondary small"
                type="submit"
                disabled={busy === `booking-type-${bookingType.id}`}
                style={{ justifySelf: "start" }}
              >
                Save booking type
              </button>
            </form>

            <div style={{ marginTop: 18, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
              <b style={{ fontSize: 13 }}>Weekly availability</b>
              <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {(windowsByType.get(bookingType.id) ?? []).map((window) => (
                  <div
                    key={window.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      alignItems: "center",
                      fontSize: 12.5,
                    }}
                  >
                    <span>
                      {WEEKDAYS[window.weekday]} · {clockFromMinutes(window.startMinute)} to {clockFromMinutes(window.endMinute)}
                    </span>
                    <button
                      className="btn ghost small"
                      type="button"
                      disabled={busy === `del-window-${window.id}`}
                      onClick={() =>
                        run(`del-window-${window.id}`, () =>
                          deleteAvailabilityWindowAdminAction(window.id),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {(windowsByType.get(bookingType.id) ?? []).length === 0 && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    No weekly availability windows.
                  </span>
                )}
              </div>

              {bookingType.active && (
                <form
                  onSubmit={(event) => submitWindow(event, bookingType.id)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    gap: 8,
                    marginTop: 12,
                    alignItems: "end",
                  }}
                >
                  <label style={labelStyle}>
                    Day
                    <select name="weekday" defaultValue="0" style={fieldStyle}>
                      {WEEKDAYS.map((day, index) => (
                        <option key={day} value={index}>{day}</option>
                      ))}
                    </select>
                  </label>
                  <label style={labelStyle}>
                    Start
                    <input name="start" type="time" defaultValue="09:00" required style={fieldStyle} />
                  </label>
                  <label style={labelStyle}>
                    End
                    <input name="end" type="time" defaultValue="17:00" required style={fieldStyle} />
                  </label>
                  <button
                    className="btn ghost small"
                    type="submit"
                    disabled={busy === `window-${bookingType.id}`}
                  >
                    Add window
                  </button>
                </form>
              )}
            </div>
          </details>
        ))}
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2 style={sectionTitleStyle}>Orders & payment truth</h2>
        {initial.orders.length === 0 ? (
          <div style={cardStyle} className="muted">No Orders yet.</div>
        ) : (
          initial.orders.map((order) => {
            const offer = offerById.get(order.offerId);
            const canRecordManual =
              order.accessMode === "MANUAL_INVOICE" &&
              (order.status === "PENDING" || order.status === "REQUIRES_ACTION");
            return (
              <div key={order.id} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <b>{offer?.title || order.offerId}</b>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {order.customerEmail} · {money(order.amountMinor, order.currency)}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {order.accessMode} · created {dateTime(order.createdAt)}
                    </div>
                  </div>
                  <StatusPill>{order.status}</StatusPill>
                </div>
                {canRecordManual && (
                  <button
                    type="button"
                    className="btn primary small"
                    style={{ marginTop: 14 }}
                    disabled={busy === `pay-${order.id}`}
                    onClick={() => recordManualPayment(order)}
                  >
                    Record manual payment
                  </button>
                )}
                <OrderAudit
                  history={initial.orderHistoryByOrder[order.id] ?? []}
                  events={initial.paymentEventsByOrder[order.id] ?? []}
                />
              </div>
            );
          })
        )}
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2 style={sectionTitleStyle}>Orchestration health</h2>
        <div style={cardStyle}>
          {initial.orchestrationEffects.length === 0 ? (
            <span className="muted">No durable side effects queued yet.</span>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {initial.orchestrationEffects.slice(0, 40).map((effect) => (
                <div
                  key={effect.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(180px, 1fr) auto auto",
                    gap: 10,
                    alignItems: "center",
                    fontSize: 12,
                    paddingBottom: 8,
                    borderBottom: "1px solid var(--line)",
                  }}
                >
                  <span>
                    <b>{effect.effectType}</b>
                    <span className="muted"> · {effect.subjectType}:{effect.subjectId}</span>
                  </span>
                  <StatusPill>{effect.status}</StatusPill>
                  <span className="muted">{effect.providerKind}</span>
                  {effect.lastErrorMessage && (
                    <span style={{ gridColumn: "1 / -1", color: "#7c2d12" }}>
                      {effect.lastErrorCode}: {effect.lastErrorMessage}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function BookingTypeFields({ value }: { value?: BookingTypeRow }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 10,
      }}
    >
      <label style={labelStyle}>
        Title
        <input name="title" defaultValue={value?.title ?? ""} required style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Slug
        <input name="slug" defaultValue={value?.slug ?? ""} required style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Description
        <input name="description" defaultValue={value?.description ?? ""} style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Timezone
        <input name="timezone" defaultValue={value?.timezone ?? "Africa/Cairo"} required style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Duration minutes
        <input name="durationMinutes" type="number" min={1} defaultValue={value?.durationMinutes ?? 60} required style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Buffer before
        <input name="bufferBeforeMinutes" type="number" min={0} defaultValue={value?.bufferBeforeMinutes ?? 0} required style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Buffer after
        <input name="bufferAfterMinutes" type="number" min={0} defaultValue={value?.bufferAfterMinutes ?? 0} required style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Minimum notice
        <input name="minimumNoticeMinutes" type="number" min={0} defaultValue={value?.minimumNoticeMinutes ?? 1440} required style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Horizon days
        <input name="bookingHorizonDays" type="number" min={1} defaultValue={value?.bookingHorizonDays ?? 30} required style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Confirmation
        <select name="confirmationPolicy" defaultValue={value?.confirmationPolicy ?? "AHMED_APPROVAL"} style={fieldStyle}>
          {CONFIRMATION_POLICIES.map((policy) => (
            <option key={policy} value={policy}>{policy}</option>
          ))}
        </select>
      </label>
      <label style={labelStyle}>
        Booking access
        <select name="accessMode" defaultValue={value?.accessMode ?? "FREE"} style={fieldStyle}>
          {BOOKING_ACCESS_MODES.map((mode) => (
            <option key={mode} value={mode}>{mode}</option>
          ))}
        </select>
      </label>
      <label style={labelStyle}>
        Meeting method
        <select name="meetingMethod" defaultValue={value?.meetingMethod ?? "TO_BE_CONFIRMED"} style={fieldStyle}>
          {MEETING_METHODS.map((method) => (
            <option key={method} value={method}>{method}</option>
          ))}
        </select>
      </label>
      <label style={labelStyle}>
        Attendee limit
        <input name="attendeeLimit" type="number" min={1} defaultValue={value?.attendeeLimit ?? 1} required style={fieldStyle} />
      </label>
    </div>
  );
}

function BookingAudit({ rows }: { rows: BookingHistoryRow[] }) {
  return (
    <details style={{ marginTop: 14 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
        Audit history ({rows.length})
      </summary>
      <div style={{ display: "grid", gap: 7, marginTop: 9 }}>
        {rows.map((row) => (
          <div key={row.id} style={{ fontSize: 12 }}>
            <b>{row.action}</b> · {row.fromStatus || "START"} → {row.toStatus}
            <span className="muted"> · {dateTime(row.createdAt)}</span>
            {row.actorId && <span className="muted"> · actor {row.actorId}</span>}
          </div>
        ))}
        {rows.length === 0 && <span className="muted">No audit events.</span>}
      </div>
    </details>
  );
}

function OrderAudit({
  history,
  events,
}: {
  history: OrderHistoryRow[];
  events: PaymentEventRow[];
}) {
  return (
    <details style={{ marginTop: 14 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
        Order audit ({history.length} transitions, {events.length} payment events)
      </summary>
      <div style={{ display: "grid", gap: 7, marginTop: 9 }}>
        {history.map((row) => (
          <div key={row.id} style={{ fontSize: 12 }}>
            <b>{row.source}</b> · {row.fromStatus || "START"} → {row.toStatus}
            <span className="muted"> · {dateTime(row.createdAt)}</span>
          </div>
        ))}
        {events.map((row) => (
          <div key={row.id} style={{ fontSize: 12 }}>
            <b>{row.source}</b> payment event · {row.state}
            <span className="muted">
              {" "}· {row.provider || "provider-neutral"} · {dateTime(row.createdAt)}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
