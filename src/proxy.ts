import { NextResponse, type NextRequest } from "next/server";
import { loginRedirectHref } from "@/lib/safe-redirect";

/**
 * Optimistic signed-out guard for the classroom (`/learn/*`).
 *
 * The layout's server check (`src/app/learn/layout.tsx`) stays the secure,
 * database-backed gate, but a server layout cannot know the requested path —
 * so on its own it bounces every deep link to `/login?redirect=/learn`.
 * This proxy preserves the full path (and query) using the documented
 * `req.nextUrl` pattern, scoped to the dynamic, private `/learn` area only:
 * no cached public path reads request state.
 *
 * The check is optimistic on purpose (cookie presence only, no DB read, per
 * the auth docs): a present-but-invalid session still falls through to the
 * layout, which redirects securely. Stale cookies therefore degrade to the
 * old behaviour, never to unauthorized access.
 */
const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
  "better-auth-session_token",
  "__Secure-better-auth-session_token",
];

export default function proxy(req: NextRequest) {
  const hasSession = SESSION_COOKIE_NAMES.some((name) => req.cookies.has(name));
  if (hasSession) return NextResponse.next();
  return NextResponse.redirect(
    new URL(loginRedirectHref(req.nextUrl.pathname, req.nextUrl.search), req.url),
  );
}

export const config = {
  matcher: ["/learn/:path*"],
};
