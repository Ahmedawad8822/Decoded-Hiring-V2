import { redirect } from "next/navigation";

import { CommerceAdminClient } from "./commerce-client";
import { getServerSession } from "@/lib/auth";
import { getCommerceAdminDashboard } from "@/features/commerce/admin";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Scheduling & Commerce · Studio | Decoded Hiring",
  description: "Offers, booking operations, payment truth and provider readiness.",
};

export default async function AdminCommercePage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");

  const dashboard = await getCommerceAdminDashboard();

  return <CommerceAdminClient initial={dashboard} />;
}
