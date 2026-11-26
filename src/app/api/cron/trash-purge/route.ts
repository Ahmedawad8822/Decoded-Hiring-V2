import { TRASH_PURGE_BATCH_LIMIT } from "@/features/publishing/lifecycle";
import { purgeExpiredTrash } from "@/features/trash/service";
import { archiveEndedCampaigns } from "@/features/landing-pages/service";
import { revalidatePath } from "next/cache";
import { isValidDrainToken } from "@/lib/email/drain-token";

// ============================================================================
// INTERNAL TRASH PURGE ROUTE (§1 lifecycle auto-purge)
// ----------------------------------------------------------------------------
// POST-only cron target. The worker's `scheduled()` handler calls this
// in-process with the per-isolate drain token; every other caller (missing or
// wrong token, or a GET) gets a 404. Deletes (a few per type per run) items
// trashed longer than the retention window, with the same dependency checks
// as manual permanent delete — protected items stay in Trash and stay flagged.
// Private, no-store, and excluded from the sitemap/prewarm (neither lists
// /api/* paths).
// ============================================================================

export const dynamic = "force-dynamic";

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  if (!isValidDrainToken(request.headers.get("x-email-drain-token"))) {
    return notFound();
  }
  const now = new Date();
  const purged = await purgeExpiredTrash(now, TRASH_PURGE_BATCH_LIMIT);
  // Campaigns past their end date move to archived (bounded per run).
  const archivedIds = await archiveEndedCampaigns(now, 20);
  if (archivedIds.length > 0) {
    revalidatePath("/sitemap.xml");
    revalidatePath("/admin/content");
  }
  return Response.json(
    { purged, archivedCampaigns: archivedIds.length },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function GET() {
  return notFound();
}
