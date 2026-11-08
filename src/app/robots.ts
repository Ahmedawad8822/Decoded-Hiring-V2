import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/seo";

// ============================================================================
// ROBOTS — remediation B.3
// ----------------------------------------------------------------------------
// Robots is a crawler-hint mechanism, NOT security: auth surfaces are enforced
// server-side by sessions and route guards regardless of what is disallowed
// here. The policy keeps crawlers out of internal application surfaces that
// have no public-index value (admin studio, learner classroom, API, auth
// screens). Auth/private surfaces additionally carry noindex metadata so a
// linked or cached URL is not indexed even when a crawler ignores robots.
// Public /api/og and /api/media are explicitly ALLOWED.
// ============================================================================

// This policy has no article-data dependency; edits deploy with the build.
export const revalidate = 3600;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/api/og", "/api/media"],
        disallow: [
          "/admin",
          "/admin/*",
          "/learn",
          "/learn/*",
          "/api/*",
          "/login",
          "/signup",
          "/review",
          "/prototypes",
        ],
      },
    ],
    sitemap: new URL("/sitemap.xml", getSiteUrl()).toString(),
  };
}
