"use client";

import { useState } from "react";
import type { CommerceAdminDashboard, CommerceAdminOrder, CommerceAdminOrderAudit } from "@/features/commerce/admin-model";
import { getOrderAuditAdminAction, recordManualPaymentAdminAction } from "@/features/commerce/admin-actions";
import { BoundedListNote, ErrorBanner, StatusPill, cardStyle, dateTime, fieldStyle, labelStyle, money, sectionTitleStyle, useAdminMutation } from "./admin-ui";

function OrderAudit({ orderId }:{orderId:string}) {
  const [audit,setAudit]=useState<CommerceAdminOrderAudit|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string|null>(null);
  async function load(){
    setLoading(true);setError(null);
    const result=await getOrderAuditAdminAction(orderId);
    if(result.ok)setAudit(result.data);else setError(result.error);
    setLoading(false);
  }
  if(!audit)return <div style={{marginTop:12}}><button className="btn ghost small" type="button" onClick={load} disabled={loading}>{loading?"Loading audit…":"Load Order audit"}</button>{error&&<p style={{fontSize:12,color:"#7c2d12"}}>{error}</p>}</div>;
  return <details open style={{marginTop:12}}><summary style={{cursor:"pointer",fontSize:12,fontWeight:700}}>Order audit ({audit.history.total} transitions, {audit.paymentEvents.total} payment events)</summary>
    <div style={{display:"grid",gap:7,marginTop:9}}>
      {audit.history.items.map(row=><div key={row.id} style={{fontSize:12}}><b>{row.source}</b> · {row.fromStatus||"START"} → {row.toStatus}<span className="muted"> · {dateTime(row.createdAt)}</span></div>)}
      {audit.paymentEvents.items.map(row=><div key={row.id} style={{fontSize:12}}><b>{row.source}</b> payment event · {row.state}<span className="muted"> · {row.provider||"provider-neutral"} · {dateTime(row.createdAt)}</span></div>)}
      <BoundedListNote list={audit.history} label="Order transitions"/>
      <BoundedListNote list={audit.paymentEvents} label="payment events"/>
    </div>
  </details>;
}

function OrderCard({order,title}:{order:CommerceAdminOrder;title:string}) {
  const mutation=useAdminMutation();
  const [note,setNote]=useState("");
  const canRecord=order.accessMode==="MANUAL_INVOICE" && (order.status==="PENDING"||order.status==="REQUIRES_ACTION");

  async function record(){
    const evidence=note.trim();
    if(evidence.length<5){mutation.setError("Add a payment reference or evidence note with at least 5 characters.");return;}
    const amount=money(order.amountMinor,order.currency);
    const ok=window.confirm(
      `Record manual payment for Order ${order.id}?\n\nCustomer: ${order.customerEmail}\nAmount: ${amount}\nEvidence: ${evidence}\n\nThis changes internal financial truth to PAID and queues fulfillment. This is not merely a note.`
    );
    if(!ok)return;
    const success=await mutation.run(`pay-${order.id}`,()=>recordManualPaymentAdminAction({orderId:order.id,expectedVersion:order.version,note:evidence}));
    if(success)setNote("");
  }

  return <div style={cardStyle}>
    <ErrorBanner error={mutation.error}/>
    <div style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div><b>{title}</b><div className="muted" style={{fontSize:12,marginTop:4}}>{order.customerEmail} · {money(order.amountMinor,order.currency)}</div><div className="muted" style={{fontSize:12}}>{order.accessMode} · created {dateTime(order.createdAt)}</div><div className="muted" style={{fontSize:11,marginTop:3}}>Order {order.id}</div></div>
      <StatusPill>{order.status}</StatusPill>
    </div>
    {canRecord&&<div style={{display:"grid",gap:8,marginTop:14,maxWidth:680}}>
      <label style={labelStyle}>Payment reference / evidence note<input value={note} onChange={e=>setNote(e.target.value)} minLength={5} placeholder="Bank transfer ref, invoice receipt, or verification note" style={fieldStyle}/></label>
      <div className="muted" style={{fontSize:11}}>Recording payment marks this Order PAID and queues durable fulfillment. Verify the evidence before committing.</div>
      <button type="button" className="btn primary small" style={{justifySelf:"start"}} disabled={mutation.busy===`pay-${order.id}`} onClick={record}>Review & record payment</button>
    </div>}
    <OrderAudit orderId={order.id}/>
  </div>;
}

export function OrdersSection({initial}:{initial:CommerceAdminDashboard}) {
  const offerMap=new Map(initial.offers.items.map(o=>[o.id,o.title]));
  return <section style={{display:"grid",gap:14}}>
    <div><h2 style={sectionTitleStyle}>Orders & payment truth</h2><p className="muted" style={{fontSize:12.5,margin:"5px 0 0"}}>Financial state is internal business truth. Manual payment requires operator evidence and explicit confirmation.</p><BoundedListNote list={initial.orders} label="Orders"/></div>
    {initial.orders.items.length===0?<div style={cardStyle} className="muted">No Orders yet.</div>:initial.orders.items.map(order=><OrderCard key={order.id} order={order} title={offerMap.get(order.offerId)||order.offerId}/>)}
  </section>;
}
