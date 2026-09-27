"use client";

import { useState } from "react";
import type { CommerceAdminBooking, CommerceAdminBookingAudit, CommerceAdminDashboard } from "@/features/commerce/admin-model";
import { bookingDecisionAdminAction, getBookingAuditAdminAction } from "@/features/commerce/admin-actions";
import { BoundedListNote, ErrorBanner, StatusPill, cardStyle, dateTime, sectionTitleStyle, useAdminMutation } from "./admin-ui";

function BookingAudit({ bookingId }: { bookingId: string }) {
  const [audit,setAudit]=useState<CommerceAdminBookingAudit | null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    const result=await getBookingAuditAdminAction(bookingId);
    if (result.ok) setAudit(result.data); else setError(result.error);
    setLoading(false);
  }

  if (!audit) return (
    <div style={{marginTop:12}}>
      <button className="btn ghost small" type="button" onClick={load} disabled={loading}>{loading ? "Loading audit…" : "Load audit history"}</button>
      {error && <p style={{fontSize:12,color:"#7c2d12"}}>{error}</p>}
    </div>
  );
  return (
    <details open style={{marginTop:12}}>
      <summary style={{cursor:"pointer",fontSize:12,fontWeight:700}}>Audit history ({audit.history.total})</summary>
      <div style={{display:"grid",gap:7,marginTop:9}}>
        {audit.history.items.map(row=><div key={row.id} style={{fontSize:12}}><b>{row.action}</b> · {row.fromStatus || "START"} → {row.toStatus}<span className="muted"> · {dateTime(row.createdAt)}</span></div>)}
        <BoundedListNote list={audit.history} label="audit events" />
      </div>
    </details>
  );
}

function BookingCard({ booking, typeTitle, actions }: { booking:CommerceAdminBooking; typeTitle:string; actions:"request"|"approval"|"upcoming" }) {
  const mutation=useAdminMutation();

  async function decide(action:"approve"|"decline"|"cancel"|"complete") {
    let reason:string | null=null;
    if (action==="decline" || action==="cancel") {
      const answer=window.prompt(`Reason for ${action}:`);
      if (answer===null) return;
      reason=answer.trim();
      if (reason.length<3) { mutation.setError("Add a reason with at least 3 characters."); return; }
    }
    const consequence =
      action==="approve" ? "This confirms the booking when policy/payment/hold checks pass and queues operational side effects." :
      action==="decline" ? "This declines the booking and releases its owned slot." :
      action==="cancel" ? "This cancels the booking and may queue calendar/message cancellation work." :
      "This marks the confirmed booking completed.";
    if (!window.confirm(`${action.toUpperCase()} booking for ${booking.requesterName}?\n\n${consequence}`)) return;
    await mutation.run(`${action}-${booking.id}`,()=>bookingDecisionAdminAction({action,bookingId:booking.id,expectedVersion:booking.version,reason}));
  }

  return (
    <div style={cardStyle}>
      <ErrorBanner error={mutation.error} />
      <div style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
        <div>
          <b>{booking.requesterName}</b>
          <div className="muted" style={{fontSize:12,marginTop:4}}>{typeTitle} · {dateTime(booking.startAt)}</div>
          <div className="muted" style={{fontSize:12}}>{booking.requesterEmail}</div>
        </div>
        <StatusPill>{booking.status}</StatusPill>
      </div>
      <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
        {(actions==="request" || actions==="approval") && <button className="btn primary small" type="button" disabled={mutation.busy===`approve-${booking.id}`} onClick={()=>decide("approve")}>Approve / confirm</button>}
        {(actions==="request" || actions==="approval") && <button className="btn danger small" type="button" disabled={mutation.busy===`decline-${booking.id}`} onClick={()=>decide("decline")}>Decline</button>}
        {actions==="upcoming" && <button className="btn secondary small" type="button" disabled={mutation.busy===`complete-${booking.id}`} onClick={()=>decide("complete")}>Mark complete</button>}
        {actions==="upcoming" && <button className="btn danger small" type="button" disabled={mutation.busy===`cancel-${booking.id}`} onClick={()=>decide("cancel")}>Cancel</button>}
      </div>
      <BookingAudit bookingId={booking.id} />
    </div>
  );
}

function BookingQueue({ title, description, list, typeMap, actions }:{
  title:string; description:string; list:CommerceAdminDashboard["requestedBookings"]; typeMap:Map<string,string>; actions:"request"|"approval"|"upcoming"
}) {
  return (
    <section style={{display:"grid",gap:14}}>
      <div><h2 style={sectionTitleStyle}>{title}</h2><p className="muted" style={{fontSize:12.5,margin:"5px 0 0"}}>{description}</p><BoundedListNote list={list} label="bookings" /></div>
      {list.items.length===0 ? <div style={cardStyle} className="muted">No bookings in this queue.</div> :
        list.items.map(row=><BookingCard key={row.id} booking={row} typeTitle={typeMap.get(row.bookingTypeId) || row.bookingTypeId} actions={actions} />)}
    </section>
  );
}

export function BookingOperations({ initial }: { initial:CommerceAdminDashboard }) {
  const typeMap=new Map(initial.bookingTypes.items.map(row=>[row.id,row.title]));
  return (
    <>
      <BookingQueue title="Requested bookings" description="Request-only or otherwise unconfirmed requests that need operator attention." list={initial.requestedBookings} typeMap={typeMap} actions="request" />
      <BookingQueue title="Approval queue" description="Bookings explicitly waiting for Ahmed/admin approval." list={initial.approvalQueue} typeMap={typeMap} actions="approval" />
      <BookingQueue title="Upcoming bookings" description="Confirmed future bookings." list={initial.upcomingBookings} typeMap={typeMap} actions="upcoming" />
    </>
  );
}
