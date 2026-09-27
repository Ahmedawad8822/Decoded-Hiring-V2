"use client";

import type { CommerceAdminDashboard } from "@/features/commerce/admin-model";
import { BoundedListNote, StatusPill, cardStyle, sectionTitleStyle } from "./admin-ui";

export function CommerceOverview({ initial }: { initial: CommerceAdminDashboard }) {
  const summaryCards = [
    ["Active Offers", initial.summary.activeOffers],
    ["Booking Types", initial.summary.activeBookingTypes],
    ["Approval Queue", initial.summary.approvalQueue],
    ["Requests", initial.summary.requestedBookings],
    ["Upcoming", initial.summary.upcomingBookings],
    ["Open Orders", initial.summary.openOrders],
    ["Blocked Effects", initial.summary.blockedEffects],
  ] as const;

  return (
    <>
      <section aria-label="Commerce summary" style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(145px, 1fr))", gap:12 }}>
        {summaryCards.map(([label,value]) => (
          <div key={label} style={cardStyle}>
            <div className="muted" style={{fontSize:11,fontWeight:700}}>{label}</div>
            <div style={{fontSize:28,fontWeight:800,marginTop:6}}>{value}</div>
          </div>
        ))}
      </section>

      <section style={{display:"grid",gap:14}}>
        <div>
          <h2 style={sectionTitleStyle}>Provider readiness</h2>
          <p className="muted" style={{fontSize:12.5,margin:"5px 0 0"}}>Read-only status. Provider activation and credentials are intentionally unavailable here.</p>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(190px,1fr))",gap:12}}>
          {initial.providers.map((provider)=>(
            <div key={provider.kind} style={cardStyle}>
              <div style={{display:"flex",justifyContent:"space-between",gap:8}}>
                <b style={{textTransform:"capitalize"}}>{provider.kind}</b>
                <StatusPill>{provider.configured ? "CONFIGURED" : "NOT CONFIGURED"}</StatusPill>
              </div>
              <p className="muted" style={{fontSize:12,marginBottom:0}}>{provider.provider || "Provider-neutral adapter"}</p>
              {provider.statusError && <p style={{fontSize:12,color:"#7c2d12"}}>{provider.statusError}</p>}
            </div>
          ))}
        </div>
      </section>

      <section style={{display:"grid",gap:14}}>
        <h2 style={sectionTitleStyle}>Orchestration health</h2>
        <div style={cardStyle}>
          {initial.orchestrationEffects.items.length === 0 ? <span className="muted">No durable side effects queued yet.</span> : (
            <div style={{display:"grid",gap:8}}>
              {initial.orchestrationEffects.items.map((effect)=>(
                <div key={effect.id} style={{display:"grid",gridTemplateColumns:"minmax(180px,1fr) auto auto",gap:10,alignItems:"center",fontSize:12,paddingBottom:8,borderBottom:"1px solid var(--line)"}}>
                  <span><b>{effect.effectType}</b><span className="muted"> · {effect.subjectType}:{effect.subjectId}</span></span>
                  <StatusPill>{effect.status}</StatusPill>
                  <span className="muted">{effect.providerKind}</span>
                  {effect.lastErrorMessage && <span style={{gridColumn:"1 / -1",color:"#7c2d12"}}>{effect.lastErrorCode}: {effect.lastErrorMessage}</span>}
                </div>
              ))}
            </div>
          )}
          <BoundedListNote list={initial.orchestrationEffects} label="orchestration effects" />
        </div>
      </section>
    </>
  );
}
