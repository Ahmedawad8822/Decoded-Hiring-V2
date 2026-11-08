import type { MetadataRoute } from "next";
import { buildSitemapEntries } from "@/lib/sitemap-entries";

// ============================================================================
// SITEMAP ROUTE — remediation B.2
// ----------------------------------------------------------------------------
// Thin route wrapper over the shared builder in src/lib/sitemap-entries.ts
// (which the regression suite exercises directly).
// ============================================================================

// Runtime sitemap entries expire on editorial changes, with an hourly safety net.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemapEntries();
}
