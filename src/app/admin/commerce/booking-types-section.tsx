"use client";
import { humanLabel } from "../_ui";
import { Input, Select, Button } from "../_ui";

import type { CommerceAdminBookingType, CommerceAdminDashboard } from "@/features/commerce/admin-model";
import { createAvailabilityWindowAdminAction, createBookingTypeAdminAction, deleteAvailabilityWindowAdminAction, updateBookingTypeAdminAction } from "@/features/commerce/admin-actions";
import { BoundedListNote, ErrorBanner, PageControls, clockFromMinutes, integer, minutesFromClock, nullable, useAdminMutation } from "./admin-ui";

const ACCESS = ["FREE", "PAID_SESSION", "MANUAL_INVOICE", "PAYMENT_DISABLED"] as const;
const POLICIES = ["AUTO_CONFIRM", "AHMED_APPROVAL", "REQUEST_ONLY"] as const;
const MEETINGS = ["TO_BE_CONFIRMED", "GOOGLE_MEET", "EXTERNAL_LINK", "PHONE", "IN_PERSON"] as const;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Fields({ value, offerOwned = false }: { value?: CommerceAdminBookingType; offerOwned?: boolean }) {
  return <div className="s-stack s-columns-auto s-gap-10" >
    <label className="ui-field" >Title<Input className="ui-input" name="title" defaultValue={value?.title || ""} required /></label>
    <label className="ui-field" >Slug<Input className="ui-input" name="slug" defaultValue={value?.slug || ""} required /></label>
    <label className="ui-field" >Description<Input className="ui-input" name="description" defaultValue={value?.description || ""} /></label>
    <label className="ui-field" >Timezone<Input className="ui-input" name="timezone" defaultValue={value?.timezone || "Africa/Cairo"} required /></label>
    <label className="ui-field" >Duration minutes<Input className="ui-input" name="durationMinutes" type="number" min={1} defaultValue={value?.durationMinutes ?? 60} required /></label>
    <label className="ui-field" >Buffer before<Input className="ui-input" name="bufferBeforeMinutes" type="number" min={0} defaultValue={value?.bufferBeforeMinutes ?? 0} required /></label>
    <label className="ui-field" >Buffer after<Input className="ui-input" name="bufferAfterMinutes" type="number" min={0} defaultValue={value?.bufferAfterMinutes ?? 0} required /></label>
    <label className="ui-field" >Minimum notice<Input className="ui-input" name="minimumNoticeMinutes" type="number" min={0} defaultValue={value?.minimumNoticeMinutes ?? 1440} required /></label>
    <label className="ui-field" >Horizon days<Input className="ui-input" name="bookingHorizonDays" type="number" min={1} defaultValue={value?.bookingHorizonDays ?? 30} required /></label>
    <label className="ui-field" >Confirmation<Select className="ui-input" name="confirmationPolicy" defaultValue={value?.confirmationPolicy || "AHMED_APPROVAL"} >{POLICIES.map(v => <option key={v} value={v}>{humanLabel(v)}</option>)}</Select></label>
    <label className="ui-field" >Booking access<Select className="ui-input" name="accessMode" defaultValue={value?.accessMode || "FREE"} disabled={offerOwned} >{ACCESS.map(v => <option key={v} value={v}>{humanLabel(v)}</option>)}</Select>{offerOwned && <span className="muted s-text-xs" >Managed by linked Offer. Change commercial access in Offers.</span>}</label>
    <label className="ui-field" >Meeting method<Select className="ui-input" name="meetingMethod" defaultValue={value?.meetingMethod || "TO_BE_CONFIRMED"} >{MEETINGS.map(v => <option key={v} value={v}>{humanLabel(v)}</option>)}</Select></label>
    <label className="ui-field" >Attendee limit<Input className="ui-input" name="attendeeLimit" type="number" min={1} defaultValue={value?.attendeeLimit ?? 1} required /></label>
  </div>;
}

export function BookingTypesSection({ initial }: { initial: CommerceAdminDashboard }) {
  const mutation = useAdminMutation();
  const windows = new Map<string, typeof initial.windows.items>();
  for (const w of initial.windows.items) {
    const existing = windows.get(w.bookingTypeId) ?? [];
    existing.push(w);
    windows.set(w.bookingTypeId, existing);
  }
  const offerOwned = new Set(initial.linkedOfferBookingTypeIds);

  function parse(form: FormData, value?: CommerceAdminBookingType) {
    return {
      ...(value ? { id: value.id } : {}), slug: String(form.get("slug") || "").trim(), title: String(form.get("title") || "").trim(), description: nullable(form.get("description")),
      durationMinutes: integer(form.get("durationMinutes"), 60), bufferBeforeMinutes: integer(form.get("bufferBeforeMinutes"), 0), bufferAfterMinutes: integer(form.get("bufferAfterMinutes"), 0),
      minimumNoticeMinutes: integer(form.get("minimumNoticeMinutes"), 0), bookingHorizonDays: integer(form.get("bookingHorizonDays"), 30), timezone: String(form.get("timezone") || "Africa/Cairo").trim(),
      confirmationPolicy: String(form.get("confirmationPolicy") || "AHMED_APPROVAL"),
      accessMode: offerOwned.has(value?.id || "") && value ? value.accessMode : String(form.get("accessMode") || "FREE"),
      meetingMethod: String(form.get("meetingMethod") || "TO_BE_CONFIRMED"), attendeeLimit: integer(form.get("attendeeLimit"), 1),
      ...(value ? { active: form.get("active") === "on" } : {}),
    };
  }

  return <section className="s-stack s-gap-14" id="booking-types" >
    <div className="s-row s-justify-content-space-between s-gap-12 s-flex-wrap-wrap" >
      <div><h2 className="section-title" >Booking types & availability</h2><BoundedListNote list={initial.bookingTypes} label="booking types" /><BoundedListNote list={initial.windows} label="availability windows on this page" /></div>
      <PageControls pageKey="bookingTypes" list={initial.bookingTypes} anchor="booking-types" />
    </div>
    <ErrorBanner error={mutation.error} />
    <details className="ui-card" ><summary className="s-bold" >Create booking type</summary>
      <form className="s-stack s-gap-12 s-margin-top-16" onSubmit={async e => { e.preventDefault(); await mutation.run("create-booking-type", () => createBookingTypeAdminAction(parse(new FormData(e.currentTarget)))); }} ><Fields /><Button className="btn primary small s-justify-self-start" disabled={mutation.busy === "create-booking-type"} >Create booking type</Button></form>
    </details>
    {initial.bookingTypes.items.map(bt => <details className="ui-card" key={bt.id} ><summary ><b>{bt.title}</b> <span className="muted s-text-sm" >· {bt.confirmationPolicy} · {bt.accessMode} · {bt.active ? "ACTIVE" : "INACTIVE"}</span></summary>
      <form className="s-stack s-gap-12 s-margin-top-16" onSubmit={async e => { e.preventDefault(); await mutation.run(`booking-type-${bt.id}`, () => updateBookingTypeAdminAction(parse(new FormData(e.currentTarget), bt))); }} ><Fields value={bt} offerOwned={offerOwned.has(bt.id)} /><label className="ui-field s-row s-align-items-center s-gap-8" ><Input name="active" type="checkbox" defaultChecked={bt.active} />Active</label><Button className="btn secondary small s-justify-self-start" disabled={mutation.busy === `booking-type-${bt.id}`} >Save booking type</Button></form>
      <div className="s-margin-top-18 s-border-top-1px-solid-line s-padding-top-16" ><b className="s-text-sm" >Weekly availability</b><div className="s-stack s-gap-8 s-margin-top-10" >
        {(windows.get(bt.id) || []).map(w => <div className="s-row s-justify-content-space-between s-gap-10 s-align-items-center s-text-sm" key={w.id} ><span>{DAYS[w.weekday]} · {clockFromMinutes(w.startMinute)} to {clockFromMinutes(w.endMinute)}</span><Button className="btn ghost small" type="button" disabled={mutation.busy === `del-window-${w.id}`} onClick={async () => { if (!window.confirm("Remove this availability window? New public slots may disappear.")) return; await mutation.run(`del-window-${w.id}`, () => deleteAvailabilityWindowAdminAction(w.id)); }}>Remove</Button></div>)}
        {(windows.get(bt.id) || []).length === 0 && <span className="muted s-text-sm" >No weekly availability windows.</span>}
      </div>
        {bt.active && <form className="s-stack s-columns-auto s-gap-8 s-margin-top-12 s-align-items-end" onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); await mutation.run(`window-${bt.id}`, () => createAvailabilityWindowAdminAction({ bookingTypeId: bt.id, weekday: integer(f.get("weekday")), startMinute: minutesFromClock(f.get("start")), endMinute: minutesFromClock(f.get("end")) })); }} >
          <label className="ui-field" >Day<Select className="ui-input" name="weekday" defaultValue="0" >{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></label>
          <label className="ui-field" >Start<Input className="ui-input" name="start" type="time" defaultValue="09:00" required /></label>
          <label className="ui-field" >End<Input className="ui-input" name="end" type="time" defaultValue="17:00" required /></label>
          <Button className="btn ghost small" disabled={mutation.busy === `window-${bt.id}`}>Add window</Button>
        </form>}
      </div>
    </details>)}
  </section>;
}
