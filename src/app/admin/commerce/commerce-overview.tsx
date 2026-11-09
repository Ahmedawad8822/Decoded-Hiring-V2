"use client";

import Link from "next/link";
import { Card, StatCard, Icon } from "../_ui";
import type { CommerceAdminDashboard } from "@/features/commerce/admin-model";
import { BoundedListNote, PageControls, StatusPill } from "./admin-ui";

function formatEventTimestampUtc(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value)) + " UTC";
}

export function CommerceProviders({ initial }: { initial: CommerceAdminDashboard }) {
  return <div className="page-stack">      <section className="s-stack s-gap-14" >
    <div>
      <h2 className="section-title" >Provider readiness</h2>
      <p className="muted s-text-sm s-margin-5px-0-0" >Check which services are ready for bookings and payments.</p>
    </div>
    <div className="s-stack s-columns-auto s-gap-12" >
      {initial.providers.map((provider) => (
        <div className="ui-card" key={provider.kind} >
          <div className="s-row s-justify-content-space-between s-gap-8" >
            <b >{provider.kind}</b>
            <StatusPill>{provider.configured ? "CONFIGURED" : "NOT CONFIGURED"}</StatusPill>
          </div>
          <p className="muted s-text-sm s-margin-bottom-0" >{provider.provider || "Not connected"}</p>
          {provider.statusError && <p className="s-text-sm s-danger" >{provider.statusError}</p>}
        </div>
      ))}
    </div>
  </section>

    <section className="s-stack s-gap-14" id="effects" >
      <div className="s-row s-justify-content-space-between s-gap-12 s-flex-wrap-wrap" >
        <h2 className="section-title" >Orchestration health</h2>
        <PageControls pageKey="effects" list={initial.orchestrationEffects} anchor="effects" />
      </div>
      <div className="ui-card" >
        {initial.orchestrationEffects.items.length === 0 ? <span className="muted">No background tasks waiting.</span> : (
          <div className="s-stack s-gap-8" >
            {initial.orchestrationEffects.items.map((effect) => (
              <div className="s-stack s-grid-template-columns-minmax-0-1fr-auto s-gap-10 s-align-items-center s-text-sm s-padding-bottom-8 s-min-width-0" key={effect.id} >
                <span className="s-min-width-0 s-overflow-wrap-anywhere" ><b>{effect.effectType}</b><span className="muted"> · {effect.subjectType}:{effect.subjectId}</span></span>
                <StatusPill>{effect.status}</StatusPill>
                <span className="muted s-grid-column-1--1 s-overflow-wrap-anywhere" >{effect.providerKind}</span>
                {effect.lastErrorMessage && <span className="s-grid-column-1--1 s-danger" >{effect.lastErrorCode}: {effect.lastErrorMessage}</span>}
              </div>
            ))}
          </div>
        )}
        <BoundedListNote list={initial.orchestrationEffects} label="background tasks" />
      </div>
    </section>
  </div>;
}

export function CommerceOverview({ initial }: { initial: CommerceAdminDashboard }) {
  const stages = [
    ["CTA clicks", initial.observability.counts.offer_cta_clicked],
    ["Booking starts", initial.observability.counts.booking_started],
    ["Slots held", initial.observability.counts.slot_held],
    ["Requests", initial.observability.counts.booking_requested],
    ["Confirmed", initial.observability.counts.booking_confirmed],
    ["Checkout starts", initial.observability.counts.checkout_started],
    ["Payments confirmed", initial.observability.counts.payment_confirmed],
    ["Payments failed", initial.observability.counts.payment_failed],
  ] as const;
  const max = Math.max(1, ...stages.map(([, value]) => value));
  return <>
    <section className="stat-grid" aria-label="Commerce summary">
      <StatCard icon="calendar" label="Approval Queue" value={initial.summary.approvalQueue} attention href="?tab=bookings" />
      <StatCard icon="inbox" label="Requests" value={initial.summary.requestedBookings} attention href="?tab=bookings" />
      <StatCard icon="clock" label="Upcoming" value={initial.summary.upcomingBookings} href="?tab=bookings" />
      <StatCard icon="orders" label="Open Orders" value={initial.summary.openOrders} attention href="?tab=orders" />
      <StatCard icon="content" label="Active Offers" value={initial.summary.activeOffers} href="?tab=offers" />
      <StatCard icon="calendar" label="Booking Types" value={initial.summary.activeBookingTypes} href="?tab=booking-types" />
    </section>
    <Card><section aria-label="30-day commerce funnel"><div className="section-heading"><div><p className="page-eyebrow">The last 30 days</p><h2>From interest to booking</h2><p className="muted">Follow each step from a first click to a confirmed session.</p></div><Icon name="arrow" /></div>
      <div className="funnel-row">{stages.map(([label, value]) => <div className="funnel-stage" key={label}><div className="funnel-label">{label}</div><div className="funnel-value">{value}</div><meter min={0} max={max} value={value} aria-label={label}>{value}</meter></div>)}</div>
      <p className="help">{initial.observability.lastEventAt ? `Last event ${formatEventTimestampUtc(initial.observability.lastEventAt)} · ${initial.observability.total} events in window.` : "Your activity will appear here as people explore and book."}</p>
    </section></Card>
    <Card className="system-summary"><div><h2>Connected &amp; running</h2><p className="muted">{initial.providers.filter(p => p.configured).length} of {initial.providers.length} providers configured · {initial.summary.blockedEffects} tasks blocked</p></div><Link href="?tab=system" className="btn secondary">Providers &amp; system <Icon name="arrow" /></Link></Card>
  </>;
}
