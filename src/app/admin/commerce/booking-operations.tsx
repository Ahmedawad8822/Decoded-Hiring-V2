"use client";
import { Button } from "../_ui";

import { useState } from "react";
import { EmptyState } from "../_ui";
import type { CommerceAdminBooking, CommerceAdminBookingAudit, CommerceAdminDashboard } from "@/features/commerce/admin-model";
import { bookingDecisionAdminAction, getBookingAuditAdminAction } from "@/features/commerce/admin-actions";
import { BoundedListNote, ErrorBanner, PageControls, StatusPill, dateTime, useAdminMutation } from "./admin-ui";

function BookingAudit({ bookingId }: { bookingId: string }) {
  const [audit, setAudit] = useState<CommerceAdminBookingAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    const result = await getBookingAuditAdminAction(bookingId);
    if (result.ok) setAudit(result.data); else setError(result.error);
    setLoading(false);
  }

  if (!audit) return (
    <div className="s-margin-top-12" >
      <Button className="btn ghost small" type="button" onClick={load} disabled={loading}>{loading ? "Loading audit…" : "Load audit history"}</Button>
      {error && <p className="s-text-sm s-danger" >{error}</p>}
    </div>
  );
  return (
    <details className="s-margin-top-12" open >
      <summary className="s-text-sm s-bold" >Audit history ({audit.history.total})</summary>
      <div className="s-stack s-gap-7 s-margin-top-9" >
        {audit.history.items.map(row => <div className="s-text-sm" key={row.id} ><b>{row.action}</b> · {row.fromStatus || "START"} → {row.toStatus}<span className="muted"> · {dateTime(row.createdAt)}</span></div>)}
        <BoundedListNote list={audit.history} label="audit events" />
      </div>
    </details>
  );
}

function BookingCard({ booking, actions }: { booking: CommerceAdminBooking; actions: "request" | "approval" | "upcoming" }) {
  const mutation = useAdminMutation();

  async function decide(action: "approve" | "decline" | "cancel" | "complete") {
    let reason: string | null = null;
    if (action === "decline" || action === "cancel") {
      const answer = window.prompt(`Reason for ${action}:`);
      if (answer === null) return;
      reason = answer.trim();
      if (reason.length < 3) { mutation.setError("Add a reason with at least 3 characters."); return; }
    }
    const consequence =
      action === "approve" ? "This confirms the booking when policy/payment/hold checks pass and queues operational side effects." :
        action === "decline" ? "This declines the booking and releases its owned slot." :
          action === "cancel" ? "This cancels the booking and may queue calendar/message cancellation work." :
            "This marks the confirmed booking completed.";
    if (!window.confirm(`${action.toUpperCase()} booking for ${booking.requesterName}?\n\n${consequence}`)) return;
    await mutation.run(`${action}-${booking.id}`, () => bookingDecisionAdminAction({ action, bookingId: booking.id, expectedVersion: booking.version, reason }));
  }

  return (
    <div className="ui-card" >
      <ErrorBanner error={mutation.error} />
      <div className="s-row s-justify-content-space-between s-gap-12 s-flex-wrap-wrap" >
        <div>
          <b>{booking.requesterName}</b>
          <div className="muted s-text-sm s-margin-top-4" >{booking.bookingTypeTitle} · {dateTime(booking.startAt)}</div>
          <div className="muted s-text-sm" >{booking.requesterEmail}</div>
        </div>
        <StatusPill>{booking.status}</StatusPill>
      </div>
      <div className="s-row s-gap-8 s-margin-top-14 s-flex-wrap-wrap" >
        {(actions === "request" || actions === "approval") && <Button className="btn primary small" type="button" disabled={mutation.busy === `approve-${booking.id}`} onClick={() => decide("approve")}>Approve / confirm</Button>}
        {(actions === "request" || actions === "approval") && <Button className="btn danger small" type="button" disabled={mutation.busy === `decline-${booking.id}`} onClick={() => decide("decline")}>Decline</Button>}
        {actions === "upcoming" && <Button className="btn secondary small" type="button" disabled={mutation.busy === `complete-${booking.id}`} onClick={() => decide("complete")}>Mark complete</Button>}
        {actions === "upcoming" && <Button className="btn danger small" type="button" disabled={mutation.busy === `cancel-${booking.id}`} onClick={() => decide("cancel")}>Cancel</Button>}
      </div>
      <BookingAudit bookingId={booking.id} />
    </div>
  );
}

function BookingQueue({ title, description, list, pageKey, anchor, actions }: {
  title: string;
  description: string;
  list: CommerceAdminDashboard["requestedBookings"];
  pageKey: "requested" | "approvals" | "upcoming";
  anchor: string;
  actions: "request" | "approval" | "upcoming";
}) {
  return (
    <section className="s-stack s-gap-14" id={anchor} >
      <div className="s-row s-justify-content-space-between s-gap-12 s-flex-wrap-wrap" >
        <div><h2 className="section-title" >{title}</h2><p className="muted s-text-sm s-margin-5px-0-0" >{description}</p><BoundedListNote list={list} label="bookings" /></div>
        <PageControls pageKey={pageKey} list={list} anchor={anchor} />
      </div>
      {list.items.length === 0 ? <EmptyState icon="calendar" title="All clear in this queue">Bookings will appear here when they’re ready.</EmptyState> :
        list.items.map(row => <BookingCard key={row.id} booking={row} actions={actions} />)}
    </section>
  );
}

export function BookingOperations({ initial }: { initial: CommerceAdminDashboard }) {
  return (
    <>
      <BookingQueue title="Requested bookings" description="Request-only or otherwise unconfirmed requests that need operator attention." list={initial.requestedBookings} pageKey="requested" anchor="requested" actions="request" />
      <BookingQueue title="Approval queue" description="Bookings explicitly waiting for Ahmed/admin approval." list={initial.approvalQueue} pageKey="approvals" anchor="approvals" actions="approval" />
      <BookingQueue title="Upcoming bookings" description="Confirmed future bookings." list={initial.upcomingBookings} pageKey="upcoming" anchor="upcoming" actions="upcoming" />
    </>
  );
}
