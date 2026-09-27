"use client";

import { useMemo } from "react";
import type { CommerceAdminBookingType, CommerceAdminDashboard } from "@/features/commerce/admin-model";
import { createAvailabilityWindowAdminAction, createBookingTypeAdminAction, deleteAvailabilityWindowAdminAction, updateBookingTypeAdminAction } from "@/features/commerce/admin-actions";
import { BoundedListNote, ErrorBanner, cardStyle, clockFromMinutes, fieldStyle, integer, labelStyle, minutesFromClock, nullable, sectionTitleStyle, useAdminMutation } from "./admin-ui";

const ACCESS=["FREE","PAID_SESSION","MANUAL_INVOICE","PAYMENT_DISABLED"] as const;
const POLICIES=["AUTO_CONFIRM","AHMED_APPROVAL","REQUEST_ONLY"] as const;
const MEETINGS=["TO_BE_CONFIRMED","GOOGLE_MEET","EXTERNAL_LINK","PHONE","IN_PERSON"] as const;
const DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function Fields({value,offerOwned=false}:{value?:CommerceAdminBookingType;offerOwned?:boolean}) {
  return <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
    <label style={labelStyle}>Title<input name="title" defaultValue={value?.title||""} required style={fieldStyle}/></label>
    <label style={labelStyle}>Slug<input name="slug" defaultValue={value?.slug||""} required style={fieldStyle}/></label>
    <label style={labelStyle}>Description<input name="description" defaultValue={value?.description||""} style={fieldStyle}/></label>
    <label style={labelStyle}>Timezone<input name="timezone" defaultValue={value?.timezone||"Africa/Cairo"} required style={fieldStyle}/></label>
    <label style={labelStyle}>Duration minutes<input name="durationMinutes" type="number" min={1} defaultValue={value?.durationMinutes??60} required style={fieldStyle}/></label>
    <label style={labelStyle}>Buffer before<input name="bufferBeforeMinutes" type="number" min={0} defaultValue={value?.bufferBeforeMinutes??0} required style={fieldStyle}/></label>
    <label style={labelStyle}>Buffer after<input name="bufferAfterMinutes" type="number" min={0} defaultValue={value?.bufferAfterMinutes??0} required style={fieldStyle}/></label>
    <label style={labelStyle}>Minimum notice<input name="minimumNoticeMinutes" type="number" min={0} defaultValue={value?.minimumNoticeMinutes??1440} required style={fieldStyle}/></label>
    <label style={labelStyle}>Horizon days<input name="bookingHorizonDays" type="number" min={1} defaultValue={value?.bookingHorizonDays??30} required style={fieldStyle}/></label>
    <label style={labelStyle}>Confirmation<select name="confirmationPolicy" defaultValue={value?.confirmationPolicy||"AHMED_APPROVAL"} style={fieldStyle}>{POLICIES.map(v=><option key={v}>{v}</option>)}</select></label>
    <label style={labelStyle}>Booking access<select name="accessMode" defaultValue={value?.accessMode||"FREE"} disabled={offerOwned} style={fieldStyle}>{ACCESS.map(v=><option key={v}>{v}</option>)}</select>{offerOwned && <span className="muted" style={{fontSize:11}}>Managed by linked Offer. Change commercial access in Offers.</span>}</label>
    <label style={labelStyle}>Meeting method<select name="meetingMethod" defaultValue={value?.meetingMethod||"TO_BE_CONFIRMED"} style={fieldStyle}>{MEETINGS.map(v=><option key={v}>{v}</option>)}</select></label>
    <label style={labelStyle}>Attendee limit<input name="attendeeLimit" type="number" min={1} defaultValue={value?.attendeeLimit??1} required style={fieldStyle}/></label>
  </div>;
}

export function BookingTypesSection({initial}:{initial:CommerceAdminDashboard}) {
  const mutation=useAdminMutation();
  const windows=useMemo(()=>{const m=new Map<string,typeof initial.windows.items>();for(const w of initial.windows.items){const a=m.get(w.bookingTypeId)||[];a.push(w);m.set(w.bookingTypeId,a);}return m;},[initial.windows.items]);
  const offerOwned=new Set(initial.linkedOfferBookingTypeIds);

  function parse(form:FormData,value?:CommerceAdminBookingType) {
    return {
      ...(value?{id:value.id}:{}), slug:String(form.get("slug")||"").trim(),title:String(form.get("title")||"").trim(),description:nullable(form.get("description")),
      durationMinutes:integer(form.get("durationMinutes"),60),bufferBeforeMinutes:integer(form.get("bufferBeforeMinutes"),0),bufferAfterMinutes:integer(form.get("bufferAfterMinutes"),0),
      minimumNoticeMinutes:integer(form.get("minimumNoticeMinutes"),0),bookingHorizonDays:integer(form.get("bookingHorizonDays"),30),timezone:String(form.get("timezone")||"Africa/Cairo").trim(),
      confirmationPolicy:String(form.get("confirmationPolicy")||"AHMED_APPROVAL"),
      accessMode: offerOwned.has(value?.id||"") && value ? value.accessMode : String(form.get("accessMode")||"FREE"),
      meetingMethod:String(form.get("meetingMethod")||"TO_BE_CONFIRMED"),attendeeLimit:integer(form.get("attendeeLimit"),1),
      ...(value?{active:form.get("active")==="on"}:{}),
    };
  }

  return <section style={{display:"grid",gap:14}}>
    <div><h2 style={sectionTitleStyle}>Booking types & availability</h2><BoundedListNote list={initial.bookingTypes} label="booking types" /><BoundedListNote list={initial.windows} label="availability windows" /></div>
    <ErrorBanner error={mutation.error}/>
    <details style={cardStyle}><summary style={{cursor:"pointer",fontWeight:700}}>Create booking type</summary>
      <form onSubmit={async e=>{e.preventDefault();await mutation.run("create-booking-type",()=>createBookingTypeAdminAction(parse(new FormData(e.currentTarget))));}} style={{display:"grid",gap:12,marginTop:16}}><Fields/><button className="btn primary small" disabled={mutation.busy==="create-booking-type"} style={{justifySelf:"start"}}>Create booking type</button></form>
    </details>
    {initial.bookingTypes.items.map(bt=><details key={bt.id} style={cardStyle}><summary style={{cursor:"pointer"}}><b>{bt.title}</b> <span className="muted" style={{fontSize:12}}>· {bt.confirmationPolicy} · {bt.accessMode} · {bt.active?"ACTIVE":"INACTIVE"}</span></summary>
      <form onSubmit={async e=>{e.preventDefault();await mutation.run(`booking-type-${bt.id}`,()=>updateBookingTypeAdminAction(parse(new FormData(e.currentTarget),bt)));}} style={{display:"grid",gap:12,marginTop:16}}><Fields value={bt} offerOwned={offerOwned.has(bt.id)}/><label style={{...labelStyle,display:"flex",alignItems:"center",gap:8}}><input name="active" type="checkbox" defaultChecked={bt.active}/>Active</label><button className="btn secondary small" disabled={mutation.busy===`booking-type-${bt.id}`} style={{justifySelf:"start"}}>Save booking type</button></form>
      <div style={{marginTop:18,borderTop:"1px solid var(--line)",paddingTop:16}}><b style={{fontSize:13}}>Weekly availability</b><div style={{display:"grid",gap:8,marginTop:10}}>
        {(windows.get(bt.id)||[]).map(w=><div key={w.id} style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"center",fontSize:12.5}}><span>{DAYS[w.weekday]} · {clockFromMinutes(w.startMinute)} to {clockFromMinutes(w.endMinute)}</span><button className="btn ghost small" type="button" disabled={mutation.busy===`del-window-${w.id}`} onClick={async()=>{if(!window.confirm("Remove this availability window? New public slots may disappear."))return;await mutation.run(`del-window-${w.id}`,()=>deleteAvailabilityWindowAdminAction(w.id));}}>Remove</button></div>)}
        {(windows.get(bt.id)||[]).length===0 && <span className="muted" style={{fontSize:12}}>No weekly availability windows.</span>}
      </div>
      {bt.active && <form onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);await mutation.run(`window-${bt.id}`,()=>createAvailabilityWindowAdminAction({bookingTypeId:bt.id,weekday:integer(f.get("weekday")),startMinute:minutesFromClock(f.get("start")),endMinute:minutesFromClock(f.get("end"))}));}} style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:8,marginTop:12,alignItems:"end"}}>
        <label style={labelStyle}>Day<select name="weekday" defaultValue="0" style={fieldStyle}>{DAYS.map((d,i)=><option key={d} value={i}>{d}</option>)}</select></label>
        <label style={labelStyle}>Start<input name="start" type="time" defaultValue="09:00" required style={fieldStyle}/></label>
        <label style={labelStyle}>End<input name="end" type="time" defaultValue="17:00" required style={fieldStyle}/></label>
        <button className="btn ghost small" disabled={mutation.busy===`window-${bt.id}`}>Add window</button>
      </form>}
      </div>
    </details>)}
  </section>;
}
