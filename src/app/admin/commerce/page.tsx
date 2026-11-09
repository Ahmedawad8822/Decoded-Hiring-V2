import { CommerceAdminClient } from "./commerce-client";
import { requireAdminPage } from "@/lib/auth";
import { getCommerceAdminDashboard } from "@/features/commerce/admin";
import type {
  CommerceAdminPageKey,
  CommerceAdminPageRequest,
} from "@/features/commerce/admin-model";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Bookings & offers · Studio | Decoded Hiring",
  description: "Bookings, offers, orders and connected services.",
};

function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export default async function AdminCommercePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const keys: CommerceAdminPageKey[] = [
    "offers",
    "bookingTypes",
    "requested",
    "approvals",
    "upcoming",
    "orders",
    "effects",
    "courses",
  ];
  const request: CommerceAdminPageRequest = Object.fromEntries(
    keys.map((key) => [key, parsePage(params[key])]),
  );

  const dashboard = await getCommerceAdminDashboard(request);

  const requestedTab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const tab = ["overview", "bookings", "offers", "booking-types", "orders", "system"].includes(requestedTab || "") ? requestedTab : "overview";
  return <CommerceAdminClient initial={dashboard} tab={tab} />;
}
