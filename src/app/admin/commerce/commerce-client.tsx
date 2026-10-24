"use client";

import type { CommerceAdminDashboard } from "@/features/commerce/admin-model";
import { CommerceOverview } from "./commerce-overview";
import { BookingOperations } from "./booking-operations";
import { OffersSection } from "./offers-section";
import { BookingTypesSection } from "./booking-types-section";
import { OrdersSection } from "./orders-section";

export function CommerceAdminClient({ initial }: { initial: CommerceAdminDashboard }) {
  return (
    <div style={{ display: "grid", gap: 28 }}>
      <div>
        <h1 className="a-h1" style={{ marginBottom: 6 }}>
          Scheduling & Commerce
        </h1>
        <p className="muted" style={{ margin: 0, maxWidth: 760 }}>
          One operational view of Offers, booking policy, requests, approvals,
          payment truth, provider readiness and durable side effects. External
          providers remain fail-closed until separately configured.
        </p>
      </div>

      <CommerceOverview initial={initial} />
      <BookingOperations initial={initial} />
      <OffersSection initial={initial} />
      <BookingTypesSection initial={initial} />
      <OrdersSection initial={initial} />
    </div>
  );
}
