import { runLearnerAutomations } from "@/features/automations/service";
import { isValidDrainToken } from "@/lib/email/drain-token";

// ============================================================================
// LEARNER AUTOMATIONS CRON (Batch J)
// ----------------------------------------------------------------------------
// POST-only cron target, gated EXACTLY like the email-drain route (same token
// header, 404 otherwise). The worker's `scheduled()` handler calls this
// in-process roughly hourly; every other caller gets a 404. Private, no-store,
// and excluded from the sitemap/prewarm (neither lists /api/* paths).
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
  const counts = await runLearnerAutomations();
  return Response.json(counts, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET() {
  return notFound();
}
