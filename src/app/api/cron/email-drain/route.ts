import { drainOutbox } from "@/lib/email/outbox";
import { isValidDrainToken } from "@/lib/email/drain-token";

// ============================================================================
// INTERNAL EMAIL DRAIN ROUTE (Batch G)
// ----------------------------------------------------------------------------
// POST-only cron target. The worker's `scheduled()` handler calls this
// in-process with the per-isolate drain token; every other caller (missing
// or wrong token, or a GET) gets a 404. Private, no-store, and excluded from
// the sitemap/prewarm (neither lists /api/* paths).
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
  const counts = await drainOutbox({ limit: 20 });
  return Response.json(counts, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET() {
  return notFound();
}
