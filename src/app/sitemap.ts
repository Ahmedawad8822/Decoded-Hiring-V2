import type { MetadataRoute } from "next";
import { buildSitemapEntries } from "@/lib/sitemap-entries";

// ============================================================================
// SITEMAP ROUTE — remediation B.2
// ----------------------------------------------------------------------------
// Thin route wrapper over the shared builder in src/lib/sitemap-entries.ts
// (which the regression suite exercises directly).
// ============================================================================

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemapEntries();
}
