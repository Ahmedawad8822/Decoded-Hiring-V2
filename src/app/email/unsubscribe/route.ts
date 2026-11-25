import { escapeHtml } from "@/lib/email/templates";
import { setCourseNudgesOptIn, verifyUnsubscribeToken } from "@/lib/email/preferences";

// ============================================================================
// COURSE-REMINDER UNSUBSCRIBE (Batch J)
// ----------------------------------------------------------------------------
// GET shows a confirm page with a button (no side effect); POST sets
// course_nudges=false (idempotent). No sign-in: the HMAC token proves the
// link came from our own email. Private, no-store, noindex on every response.
// ============================================================================

export const dynamic = "force-dynamic";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
} as const;

function page(title: string, body: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />` +
      `<meta name="robots" content="noindex" />` +
      `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
      `<title>${escapeHtml(title)}</title></head>` +
      `<body style="font-family:Arial,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;">` +
      `<h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status: 200, headers: { ...HEADERS } },
  );
}

function paramsOf(request: Request): { u: string; t: string } {
  const url = new URL(request.url);
  return { u: url.searchParams.get("u") ?? "", t: url.searchParams.get("t") ?? "" };
}

export async function GET(request: Request): Promise<Response> {
  const { u, t } = paramsOf(request);
  if (!u || !t || !(await verifyUnsubscribeToken(u, t))) {
    return page(
      "Link not recognized",
      `<p>This unsubscribe link is invalid or incomplete. ` +
        `Links come from the bottom of our course emails — please use the latest one.</p>`,
    );
  }
  return page(
    "Unsubscribe from course emails?",
    `<p>Stop course reminder emails (lesson unlocks and learning nudges) ` +
      `for this account? Transactional emails (password resets, enrollment ` +
      `confirmations) are unaffected.</p>` +
      `<form method="post" action="/email/unsubscribe">` +
      `<input type="hidden" name="u" value="${escapeHtml(u)}" />` +
      `<input type="hidden" name="t" value="${escapeHtml(t)}" />` +
      `<button type="submit" style="padding:10px 20px;font-size:15px;">Yes, unsubscribe me</button>` +
      `</form>`,
  );
}

export async function POST(request: Request): Promise<Response> {
  let u = "";
  let t = "";
  try {
    const form = await request.formData();
    u = String(form.get("u") ?? "");
    t = String(form.get("t") ?? "");
  } catch {
    return page("Link not recognized", `<p>This request could not be read. Please use the link from your email.</p>`);
  }
  if (!u || !t || !(await verifyUnsubscribeToken(u, t))) {
    return page(
      "Link not recognized",
      `<p>This unsubscribe link is invalid. Please use the latest link from one of our course emails.</p>`,
    );
  }
  await setCourseNudgesOptIn(u, false);
  return page(
    "Unsubscribed",
    `<p>Done — you won't get course reminder emails any more. ` +
      `Changed your mind? Re-enrolling keeps this choice; contact us to opt back in.</p>`,
  );
}
