"use client";

import { useState } from "react";
import type { CommerceAdminDashboard, CommerceAdminOffer } from "@/features/commerce/admin-model";
import { createOfferAdminAction, updateOfferAdminAction } from "@/features/commerce/admin-actions";
import { BoundedListNote, ErrorBanner, PageControls, cardStyle, fieldStyle, integer, labelStyle, money, nullable, sectionTitleStyle, useAdminMutation } from "./admin-ui";

const ACCESS_MODES = ["FREE","PAID_ONE_TIME","PAID_SESSION","MANUAL_INVOICE","PAYMENT_DISABLED","COMING_SOON"] as const;

export function OffersSection({ initial }: { initial:CommerceAdminDashboard }) {
  const mutation=useAdminMutation();
  const [newKind,setNewKind]=useState<CommerceAdminOffer["kind"]>("COACHING");
  const [newMode,setNewMode]=useState<CommerceAdminOffer["accessMode"]>("FREE");

  async function create(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const amount=nullable(form.get("amountMinor"));
    const bookingTypeId=(newKind==="COACHING"||newKind==="WORKSHOP") ? nullable(form.get("bookingTypeId")) : null;
    const courseId=newKind==="COURSE" ? nullable(form.get("courseId")) : null;
    await mutation.run("create-offer",()=>createOfferAdminAction({
      kind:newKind,courseId,bookingTypeId,title:String(form.get("title")||"").trim(),slug:String(form.get("slug")||"").trim(),accessMode:newMode,
      currency:nullable(form.get("currency")),amountMinor:amount===null?null:integer(form.get("amountMinor")),
      alternativeCtaLabel:nullable(form.get("alternativeCtaLabel")),alternativeCtaUrl:nullable(form.get("alternativeCtaUrl")),active:true,
    }));
  }

  async function update(event:React.FormEvent<HTMLFormElement>,offer:CommerceAdminOffer) {
    event.preventDefault(); const form=new FormData(event.currentTarget); const amount=nullable(form.get("amountMinor"));
    await mutation.run(`offer-${offer.id}`,()=>updateOfferAdminAction({
      id:offer.id,title:String(form.get("title")||"").trim(),slug:String(form.get("slug")||"").trim(),
      accessMode:String(form.get("accessMode")||offer.accessMode),currency:nullable(form.get("currency")),
      amountMinor:amount===null?null:integer(form.get("amountMinor")),alternativeCtaLabel:nullable(form.get("alternativeCtaLabel")),
      alternativeCtaUrl:nullable(form.get("alternativeCtaUrl")),active:form.get("active")==="on",
    }));
  }

  return (
    <section id="offers" style={{display:"grid",gap:14}}>
      <div style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
        <div><h2 style={sectionTitleStyle}>Offers</h2><BoundedListNote list={initial.offers} label="Offers" /></div>
        <PageControls pageKey="offers" list={initial.offers} anchor="offers" />
      </div>
      <ErrorBanner error={mutation.error} />
      <details style={cardStyle}>
        <summary style={{cursor:"pointer",fontWeight:700}}>Create Offer</summary>
        <form onSubmit={create} style={{display:"grid",gap:12,marginTop:16}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
            <label style={labelStyle}>Kind<select value={newKind} onChange={e=>setNewKind(e.target.value as CommerceAdminOffer["kind"])} style={fieldStyle}>{["COURSE","COACHING","WORKSHOP","PRODUCT"].map(v=><option key={v}>{v}</option>)}</select></label>
            <label style={labelStyle}>Title<input name="title" required minLength={3} style={fieldStyle}/></label>
            <label style={labelStyle}>Slug<input name="slug" required style={fieldStyle}/></label>
            <label style={labelStyle}>Access mode<select value={newMode} onChange={e=>setNewMode(e.target.value as CommerceAdminOffer["accessMode"])} style={fieldStyle}>{ACCESS_MODES.map(v=><option key={v}>{v}</option>)}</select></label>
            {newKind==="COURSE" && <label style={labelStyle}>Course<select name="courseId" required style={fieldStyle}><option value="">Choose course</option>{initial.courses.items.map(c=><option key={c.id} value={c.id}>{c.title} ({c.status})</option>)}</select><BoundedListNote list={initial.courses} label="courses" /><PageControls pageKey="courses" list={initial.courses} anchor="offers" /></label>}
            {(newKind==="COACHING"||newKind==="WORKSHOP") && <label style={labelStyle}>Booking type<select name="bookingTypeId" style={fieldStyle}><option value="">Lead-first / no booking type</option>{initial.bookingTypes.items.map(b=><option key={b.id} value={b.id}>{b.title}</option>)}</select></label>}
            <label style={labelStyle}>Currency<input name="currency" placeholder="USD" maxLength={3} style={fieldStyle}/></label>
            <label style={labelStyle}>Amount minor units<input name="amountMinor" type="number" min={0} step={1} style={fieldStyle}/></label>
            <label style={labelStyle}>Alternative CTA label<input name="alternativeCtaLabel" style={fieldStyle}/></label>
            <label style={labelStyle}>Alternative CTA URL<input name="alternativeCtaUrl" style={fieldStyle}/></label>
          </div>
          <button className="btn primary small" disabled={mutation.busy==="create-offer"} style={{justifySelf:"start"}}>Create Offer</button>
        </form>
      </details>

      {initial.offers.items.length===0 && <div style={cardStyle} className="muted">No Offers configured.</div>}
      {initial.offers.items.map(offer=>(
        <details key={offer.id} style={cardStyle}>
          <summary style={{cursor:"pointer"}}><b>{offer.title}</b> <span className="muted" style={{fontSize:12}}>· {offer.kind} · {offer.accessMode} · {offer.active?"ACTIVE":"INACTIVE"}</span></summary>
          <form onSubmit={e=>update(e,offer)} style={{display:"grid",gap:12,marginTop:16}}>
            <p className="muted" style={{fontSize:12,margin:0}}>Linked entity is fixed. Create a new Offer if commercial identity must change.</p>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
              <label style={labelStyle}>Title<input name="title" defaultValue={offer.title} required style={fieldStyle}/></label>
              <label style={labelStyle}>Slug<input name="slug" defaultValue={offer.slug} required style={fieldStyle}/></label>
              <label style={labelStyle}>Access mode<select name="accessMode" defaultValue={offer.accessMode} style={fieldStyle}>{ACCESS_MODES.map(v=><option key={v}>{v}</option>)}</select></label>
              <label style={labelStyle}>Currency<input name="currency" defaultValue={offer.currency||""} maxLength={3} style={fieldStyle}/></label>
              <label style={labelStyle}>Amount minor units<input name="amountMinor" type="number" min={0} step={1} defaultValue={offer.amountMinor??""} style={fieldStyle}/></label>
              <label style={labelStyle}>Alternative CTA label<input name="alternativeCtaLabel" defaultValue={offer.alternativeCtaLabel||""} style={fieldStyle}/></label>
              <label style={labelStyle}>Alternative CTA URL<input name="alternativeCtaUrl" defaultValue={offer.alternativeCtaUrl||""} style={fieldStyle}/></label>
            </div>
            <label style={{...labelStyle,display:"flex",alignItems:"center",gap:8}}><input name="active" type="checkbox" defaultChecked={offer.active}/>Active</label>
            <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}><button className="btn secondary small" disabled={mutation.busy===`offer-${offer.id}`}>Save Offer</button><span className="muted" style={{fontSize:12}}>{money(offer.amountMinor,offer.currency)}</span></div>
          </form>
        </details>
      ))}
    </section>
  );
}
