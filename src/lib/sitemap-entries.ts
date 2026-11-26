import type { MetadataRoute } from "next";
import { staticRoutes } from "./public-routes";
export { staticRoutes } from "./public-routes";
import { getSiteUrl } from "@/lib/seo";
import { getPublishedGuides } from "@/features/guides/service";
import { getPublishedFieldNotes } from "@/features/field-notes/service";
import { getSitemapPages } from "@/features/pages/service";

// ============================================================================
// SITEMAP ENTRIES — remediation B.2/B.4
// ----------------------------------------------------------------------------
// Single source of truth for sitemap content, shared by src/app/sitemap.ts
// and the regression suite. Static public marketing routes plus the canonical
// URLs of PUBLISHED guides, field notes and standard pages only. Drafts,
// archived, trashed and noindex content can never appear: the source queries
// filter on status = 'published' (and noindex = false for pages) at the
// service layer, and tests assert other slugs stay out.
// Static routes omit lastModified (stable timestamp unknown); dynamic content
// uses updatedAt. Adds max-image-preview: large via robots (not sitemap).
// ============================================================================

export async function buildSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const base = getSiteUrl().toString().replace(/\/$/, "");

  const [guides, fieldNotes, stdPages] = await Promise.all([
    getPublishedGuides(),
    getPublishedFieldNotes(),
    getSitemapPages(),
  ]);

  const staticEntries: MetadataRoute.Sitemap = staticRoutes.map((route) => ({
    url: `${base}${route}`,
    // Omit lastModified for static routes — no stable timestamp known.
    // Setting it to "now" on every request is misleading for crawlers.
  }));

  const guideEntries: MetadataRoute.Sitemap = guides.map((guide) => ({
    url: `${base}/guides/${guide.slug}`,
    lastModified: guide.updatedAt ?? undefined,
  }));

  const fieldNoteEntries: MetadataRoute.Sitemap = fieldNotes.map((note) => ({
    url: `${base}/field-notes/${note.slug}`,
    lastModified: note.updatedAt ?? undefined,
  }));

  const pageEntries: MetadataRoute.Sitemap = stdPages.map((page) => ({
    url: `${base}/${page.slug}`,
    lastModified: page.updatedAt ?? undefined,
  }));

  return [...staticEntries, ...guideEntries, ...fieldNoteEntries, ...pageEntries];
}
