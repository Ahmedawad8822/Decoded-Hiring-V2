"use client";
import { EmptyState, humanLabel, Select, Input, Button } from "../_ui";

import { useState } from "react";
import type { CommerceAdminDashboard, CommerceAdminOffer } from "@/features/commerce/admin-model";
import { createOfferAdminAction, updateOfferAdminAction } from "@/features/commerce/admin-actions";
import { BoundedListNote, ErrorBanner, PageControls, integer, money, nullable, useAdminMutation } from "./admin-ui";

const ACCESS_MODES = ["FREE", "PAID_ONE_TIME", "PAID_SESSION", "MANUAL_INVOICE", "PAYMENT_DISABLED", "COMING_SOON"] as const;

export function OffersSection({ initial }: { initial: CommerceAdminDashboard }) {
  const mutation = useAdminMutation();
  const [newKind, setNewKind] = useState<CommerceAdminOffer["kind"]>("COACHING");
  const [newMode, setNewMode] = useState<CommerceAdminOffer["accessMode"]>("FREE");

  function limitFields(form: FormData): { seatLimit: number | null; closesAt: string | null } {
    const seatRaw = nullable(form.get("seatLimit"));
    const closesRaw = nullable(form.get("closesAt"));
    return {
      seatLimit: seatRaw === null ? null : integer(form.get("seatLimit"), Number.NaN),
      closesAt: closesRaw,
    };
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = nullable(form.get("amountMinor"));
    const bookingTypeId = (newKind === "COACHING" || newKind === "WORKSHOP") ? nullable(form.get("bookingTypeId")) : null;
    const courseId = newKind === "COURSE" ? nullable(form.get("courseId")) : null;
    await mutation.run("create-offer", () => createOfferAdminAction({
      kind: newKind, courseId, bookingTypeId, title: String(form.get("title") || "").trim(), slug: String(form.get("slug") || "").trim(), accessMode: newMode,
      currency: nullable(form.get("currency")), amountMinor: amount === null ? null : integer(form.get("amountMinor")),
      alternativeCtaLabel: nullable(form.get("alternativeCtaLabel")), alternativeCtaUrl: nullable(form.get("alternativeCtaUrl")), active: true,
      ...limitFields(form),
    }));
  }

  async function update(event: React.FormEvent<HTMLFormElement>, offer: CommerceAdminOffer) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const amount = nullable(form.get("amountMinor"));
    await mutation.run(`offer-${offer.id}`, () => updateOfferAdminAction({
      id: offer.id, title: String(form.get("title") || "").trim(), slug: String(form.get("slug") || "").trim(),
      accessMode: String(form.get("accessMode") || offer.accessMode), currency: nullable(form.get("currency")),
      amountMinor: amount === null ? null : integer(form.get("amountMinor")), alternativeCtaLabel: nullable(form.get("alternativeCtaLabel")),
      alternativeCtaUrl: nullable(form.get("alternativeCtaUrl")), active: form.get("active") === "on",
      ...limitFields(form),
    }));
  }

  return (
    <section className="s-stack s-gap-14" id="offers" >
      <div className="s-row s-justify-content-space-between s-gap-12 s-flex-wrap-wrap" >
        <div><h2 className="section-title" >Offers</h2><BoundedListNote list={initial.offers} label="Offers" /></div>
        <PageControls pageKey="offers" list={initial.offers} anchor="offers" />
      </div>
      <ErrorBanner error={mutation.error} />
      <details className="ui-card" >
        <summary className="new-offer-trigger">New offer</summary>
        <form className="s-stack s-gap-12 s-margin-top-16" onSubmit={create} >
          <div className="s-stack s-columns-auto s-gap-10" >
            <label className="ui-field" >Kind<Select className="ui-input" value={newKind} onChange={e => setNewKind(e.target.value as CommerceAdminOffer["kind"])} >{["COURSE", "COACHING", "WORKSHOP", "PRODUCT"].map(v => <option key={v} value={v}>{humanLabel(v)}</option>)}</Select></label>
            <label className="ui-field" >Title<Input className="ui-input" name="title" required minLength={3} /></label>
            <label className="ui-field" >Slug<Input className="ui-input" name="slug" required /></label>
            <label className="ui-field" >Access mode<Select className="ui-input" value={newMode} onChange={e => setNewMode(e.target.value as CommerceAdminOffer["accessMode"])} >{ACCESS_MODES.map(v => <option key={v} value={v}>{humanLabel(v)}</option>)}</Select></label>
            {newKind === "COURSE" && <label className="ui-field" >Course<Select className="ui-input" name="courseId" required ><option value="">Choose course</option>{initial.courses.items.map(c => <option key={c.id} value={c.id}>{c.title} ({c.status})</option>)}</Select><BoundedListNote list={initial.courses} label="courses" /><PageControls pageKey="courses" list={initial.courses} anchor="offers" /></label>}
            {(newKind === "COACHING" || newKind === "WORKSHOP") && <label className="ui-field" >Booking type<Select className="ui-input" name="bookingTypeId" ><option value="">Lead-first / no booking type</option>{initial.bookingTypes.items.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}</Select></label>}
            <label className="ui-field" >Currency<Input className="ui-input" name="currency" placeholder="USD" maxLength={3} /></label>
            <label className="ui-field" >Amount minor units<Input className="ui-input" name="amountMinor" type="number" min={0} step={1} /></label>
            <label className="ui-field" >Alternative CTA label<Input className="ui-input" name="alternativeCtaLabel" /></label>
            <label className="ui-field" >Alternative CTA URL<Input className="ui-input" name="alternativeCtaUrl" /></label>
            <label className="ui-field" >Seat limit (blank = unlimited)<Input className="ui-input" name="seatLimit" type="number" min={1} max={10000} step={1} /></label>
            <label className="ui-field" >Closes at (blank = never)<Input className="ui-input" name="closesAt" type="datetime-local" /></label>
          </div>
          <Button className="btn primary small s-justify-self-start" disabled={mutation.busy === "create-offer"} >Create Offer</Button>
        </form>
      </details>

      {initial.offers.items.length === 0 && <EmptyState icon="content" title="Your next offer belongs here">Use New offer above to create it.</EmptyState>}
      {initial.offers.items.map(offer => (
        <details className="ui-card" key={offer.id} >
          <summary ><b>{offer.title}</b> <span className="muted s-text-sm" >· {humanLabel(offer.kind)} · {humanLabel(offer.accessMode)} · {offer.active ? "ACTIVE" : "INACTIVE"} · {offer.seatLimit == null ? "Unlimited" : `${offer.seatsTaken}/${offer.seatLimit} taken`} · {offer.limitState === "open" ? "OPEN" : offer.limitState === "sold_out" ? "SOLD OUT" : "CLOSED"}</span></summary>
          <form className="s-stack s-gap-12 s-margin-top-16" onSubmit={e => update(e, offer)} >
            <p className="muted s-text-sm s-margin-0" >Linked entity is fixed. Create a new Offer if commercial identity must change.</p>
            <div className="s-stack s-columns-auto s-gap-10" >
              <label className="ui-field" >Title<Input className="ui-input" name="title" defaultValue={offer.title} required /></label>
              <label className="ui-field" >Slug<Input className="ui-input" name="slug" defaultValue={offer.slug} required /></label>
              <label className="ui-field" >Access mode<Select className="ui-input" name="accessMode" defaultValue={offer.accessMode} >{ACCESS_MODES.map(v => <option key={v} value={v}>{humanLabel(v)}</option>)}</Select></label>
              <label className="ui-field" >Currency<Input className="ui-input" name="currency" defaultValue={offer.currency || ""} maxLength={3} /></label>
              <label className="ui-field" >Amount minor units<Input className="ui-input" name="amountMinor" type="number" min={0} step={1} defaultValue={offer.amountMinor ?? ""} /></label>
              <label className="ui-field" >Alternative CTA label<Input className="ui-input" name="alternativeCtaLabel" defaultValue={offer.alternativeCtaLabel || ""} /></label>
              <label className="ui-field" >Alternative CTA URL<Input className="ui-input" name="alternativeCtaUrl" defaultValue={offer.alternativeCtaUrl || ""} /></label>
              <label className="ui-field" >Seat limit (blank = unlimited)<Input className="ui-input" name="seatLimit" type="number" min={1} max={10000} step={1} defaultValue={offer.seatLimit ?? ""} /></label>
              <label className="ui-field" >Closes at (blank = never)<Input className="ui-input" name="closesAt" type="datetime-local" defaultValue={offer.closesAt ? offer.closesAt.slice(0, 16) : ""} /></label>
            </div>
            <label className="ui-field s-row s-align-items-center s-gap-8" ><Input name="active" type="checkbox" defaultChecked={offer.active} />Active</label>
            <div className="s-row s-gap-10 s-align-items-center s-flex-wrap-wrap" ><Button className="btn secondary small" disabled={mutation.busy === `offer-${offer.id}`}>Save Offer</Button><span className="muted s-text-sm" >{money(offer.amountMinor, offer.currency)}</span></div>
          </form>
        </details>
      ))}
    </section>
  );
}
