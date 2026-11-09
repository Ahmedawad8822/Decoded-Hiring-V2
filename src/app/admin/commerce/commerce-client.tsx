"use client";

import Link from "next/link";
import type { CommerceAdminDashboard } from "@/features/commerce/admin-model";
import { PageHeader } from "../_ui";
import { CommerceOverview, CommerceProviders } from "./commerce-overview";
import { BookingOperations } from "./booking-operations";
import { OffersSection } from "./offers-section";
import { BookingTypesSection } from "./booking-types-section";
import { OrdersSection } from "./orders-section";

export const commerceTabs = [
  ["overview", "Overview"], ["bookings", "Bookings"], ["offers", "Offers"],
  ["booking-types", "Booking types"], ["orders", "Orders"], ["system", "Providers & system"],
] as const;
export function CommerceAdminClient({ initial, tab = "overview" }: { initial: CommerceAdminDashboard; tab?: string }) {
  return <div className="page-stack">

    <PageHeader eyebrow="Business" title="Bookings & offers" description="Keep sessions moving, manage your offers, and see what needs your attention." />
    <nav className="ui-tabs commerce-tabs" aria-label="Bookings & offers views">{commerceTabs.map(([key, label]) => <Link key={key} href={`/admin/commerce?tab=${key}`} aria-current={tab === key ? "page" : undefined}>{label}</Link>)}</nav>
    {tab === "overview" && <CommerceOverview initial={initial} />}
    {tab === "bookings" && <BookingOperations initial={initial} />}
    {tab === "offers" && <OffersSection initial={initial} />}
    {tab === "booking-types" && <BookingTypesSection initial={initial} />}
    {tab === "orders" && <OrdersSection initial={initial} />}
    {tab === "system" && <CommerceProviders initial={initial} />}
  </div>;
}
