import { staticRoutes } from "@/lib/public-routes";

// ============================================================================
// RESERVED PAGE SLUGS (standard pages §3)
// ----------------------------------------------------------------------------
// A standard page lives at the site root (/[slug]), so its slug must never
// collide with an existing top-level route. This is the single exported
// list enforced on create and rename. It is built from two sources:
//   1. src/lib/public-routes.ts (`staticRoutes`: every hand-built marketing
//      path — /about, /guides, /field-notes, ...).
//   2. The top-level `src/app` directories that are not pages themselves but
//      own a URL namespace: admin, api, certificates, email, learn, preview,
//      plus auth screens, the future campaign namespace (/go) and framework
//      internals.
// Static sibling routes always win over /[slug] at request time, but the
// reservation keeps Studio from creating a page that could never render.
// ============================================================================

const STATIC_ROUTE_SLUGS = staticRoutes
  .map((route) => route.replace(/^\//, "").split("/")[0])
  .filter((segment) => segment.length > 0);

// Top-level app directories / namespaces (src/app/*) that own a URL prefix
// but have no entry in staticRoutes. Kept next to public-routes by design;
// update this list when a new top-level route group is added.
const TOP_LEVEL_SEGMENTS = [
  "admin",
  "api",
  "certificates",
  "email",
  "go",
  "learn",
  "login",
  "signup",
  "forgot-password",
  "reset-password",
  "email-verified",
  "preview",
  "review",
  "prototypes",
  // Next.js / platform internals that must never become content.
  "_next",
  "favicon",
  "fonts",
  "images",
] as const;

export const RESERVED_PAGE_SLUGS: readonly string[] = Array.from(
  new Set([...STATIC_ROUTE_SLUGS, ...TOP_LEVEL_SEGMENTS])
).sort();

export function isReservedPageSlug(slug: string): boolean {
  return (RESERVED_PAGE_SLUGS as readonly string[]).includes(slug.toLowerCase());
}
