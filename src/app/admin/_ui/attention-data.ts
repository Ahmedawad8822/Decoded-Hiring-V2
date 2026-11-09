import { cache } from "react";
import { requireAdmin } from "@/lib/auth";
import { listLeads } from "@/features/leads/admin";
import { listDrafts } from "@/features/editorial-ai/drafts/service";
import { getCommerceAdminDashboard } from "@/features/commerce/admin";

// Deduplicate the layout and Home reads within a request; never share live
// admin data across requests. These are the existing read-only projections.
export const readStudioAttention = cache(async () => {
  await requireAdmin();
  const [leads, drafts, commerce] = await Promise.all([
    listLeads({ status: "NEW", pageSize: 1 }),
    listDrafts({ status: "IN_REVIEW" }),
    getCommerceAdminDashboard(),
  ]);
  return { leads, drafts, commerce };
});
