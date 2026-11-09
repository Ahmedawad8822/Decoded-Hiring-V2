"use client";
import { Button, Input } from "../_ui";

import { useState } from "react";
import type { CommerceAdminDashboard, CommerceAdminOrder, CommerceAdminOrderAudit } from "@/features/commerce/admin-model";
import { getOrderAuditAdminAction, recordManualPaymentAdminAction } from "@/features/commerce/admin-actions";
import { BoundedListNote, ErrorBanner, PageControls, StatusPill, dateTime, money, useAdminMutation } from "./admin-ui";

function OrderAudit({ orderId }: { orderId: string }) {
  const [audit, setAudit] = useState<CommerceAdminOrderAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setLoading(true); setError(null);
    const result = await getOrderAuditAdminAction(orderId);
    if (result.ok) setAudit(result.data); else setError(result.error);
    setLoading(false);
  }
  if (!audit) return <div className="s-margin-top-12" ><Button className="btn ghost small" type="button" onClick={load} disabled={loading}>{loading ? "Loading audit…" : "Load Order audit"}</Button>{error && <p className="s-text-sm s-danger" >{error}</p>}</div>;
  return <details className="s-margin-top-12" open ><summary className="s-text-sm s-bold" >Order audit ({audit.history.total} transitions, {audit.paymentEvents.total} payment events)</summary>
    <div className="s-stack s-gap-7 s-margin-top-9" >
      {audit.history.items.map(row => <div className="s-text-sm" key={row.id} ><b>{row.source}</b> · {row.fromStatus || "START"} → {row.toStatus}<span className="muted"> · {dateTime(row.createdAt)}</span></div>)}
      {audit.paymentEvents.items.map(row => <div className="s-text-sm" key={row.id} ><b>{row.source}</b> payment event · {row.state}<span className="muted"> · {row.provider || "Manual"} · {dateTime(row.createdAt)}</span></div>)}
      <BoundedListNote list={audit.history} label="Order transitions" />
      <BoundedListNote list={audit.paymentEvents} label="payment events" />
    </div>
  </details>;
}

function OrderCard({ order, title }: { order: CommerceAdminOrder; title: string }) {
  const mutation = useAdminMutation();
  const [note, setNote] = useState("");
  const canRecord = order.accessMode === "MANUAL_INVOICE" && (order.status === "PENDING" || order.status === "REQUIRES_ACTION");

  async function record() {
    const evidence = note.trim();
    if (evidence.length < 5) { mutation.setError("Add a payment reference or evidence note with at least 5 characters."); return; }
    const amount = money(order.amountMinor, order.currency);
    const ok = window.confirm(
      `Record manual payment for Order ${order.id}?\n\nCustomer: ${order.customerEmail}\nAmount: ${amount}\nEvidence: ${evidence}\n\nThis changes internal financial truth to PAID and queues fulfillment. This is not merely a note.`
    );
    if (!ok) return;
    const success = await mutation.run(`pay-${order.id}`, () => recordManualPaymentAdminAction({ orderId: order.id, expectedVersion: order.version, note: evidence }));
    if (success) setNote("");
  }

  return <div className="ui-card" >
    <ErrorBanner error={mutation.error} />
    <div className="s-row s-justify-content-space-between s-gap-12 s-flex-wrap-wrap" >
      <div><b>{title}</b><div className="muted s-text-sm s-margin-top-4" >{order.customerEmail} · {money(order.amountMinor, order.currency)}</div><div className="muted s-text-sm" >{order.accessMode} · created {dateTime(order.createdAt)}</div><div className="muted s-text-xs s-margin-top-3" >Order {order.id}</div></div>
      <StatusPill>{order.status}</StatusPill>
    </div>
    {canRecord && <div className="s-stack s-gap-8 s-margin-top-14 s-max-width-680" >
      <label className="ui-field" >Payment reference / evidence note<Input className="ui-input" value={note} onChange={e => setNote(e.target.value)} minLength={5} placeholder="Bank transfer ref, invoice receipt, or verification note" /></label>
      <div className="muted s-text-xs" >Recording a payment marks this order as paid and starts fulfillment. Check the evidence before confirming.</div>
      <Button type="button" className="btn primary small s-justify-self-start" disabled={mutation.busy === `pay-${order.id}`} onClick={record}>Review & record payment</Button>
    </div>}
    <OrderAudit orderId={order.id} />
  </div>;
}

export function OrdersSection({ initial }: { initial: CommerceAdminDashboard }) {
  return <section className="s-stack s-gap-14" id="orders" >
    <div className="s-row s-justify-content-space-between s-gap-12 s-flex-wrap-wrap" >
      <div><h2 className="section-title" >Orders & payments</h2><p className="muted s-text-sm s-margin-5px-0-0" >Track payments and record verified payment evidence.</p><BoundedListNote list={initial.orders} label="Orders" /></div>
      <PageControls pageKey="orders" list={initial.orders} anchor="orders" />
    </div>
    {initial.orders.items.length === 0 ? <div className="muted ui-card">No Orders on this page.</div> : initial.orders.items.map(order => <OrderCard key={order.id} order={order} title={order.offerTitle} />)}
  </section>;
}
