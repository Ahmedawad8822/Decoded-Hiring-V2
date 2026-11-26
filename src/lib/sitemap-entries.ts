import type { MetadataRoute } from "next";
import { staticRoutes } from "./public-routes";
export { staticRoutes } from "./public-routes";
import { getSiteUrl } from "@/lib/seo";
import { getPublishedGuides } from "@/features/guides/service";
import { getPublishedFieldNotes } from "@/features/field-notes/service";
import { getPublicCourses } from "@/features/courses/sales";
import { getSitemapLandingPages } from "@/features/landing-pages/service";
import { getSitemapPages } from "@/features/pages/service";

// ============================================================================
// SITEMAP ENTRIES — remediation B.2/B.4
// ----------------------------------------------------------------------------
// Single source of truth for sitemap content, shared by src/app/sitemap.ts
// and the regression suite. Static public marketing routes plus the canonical
// URLs of PUBLISHED guides, field notes, courses, indexable standard pages
// and indexable live landing pages only. Drafts, archived, trashed, noindex
// and out-of-schedule content can never appear: the source queries filter at
// the service layer, and tests assert excluded slugs stay out.
// Static routes omit lastModified (stable timestamp unknown); dynamic content
// uses updatedAt. Adds max-image-preview: large via robots (not sitemap).
// ============================================================================

export async function buildSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const base = getSiteUrl().toString().replace(/\/$/, "");

  const [guides, fieldNotes, courses, stdPages, landingPages] = await Promise.all([
    getPublishedGuides(),
    getPublishedFieldNotes(),
    getPublicCourses(),
    getSitemapPages(),
    getSitemapLandingPages(),
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

  const courseEntries: MetadataRoute.Sitemap = courses.map((course) => ({
    url: `${base}/courses/${course.slug}`,
    lastModified: course.updatedAt ?? undefined,
  }));


  const pageEntries: MetadataRoute.Sitemap = stdPages.map((page) => ({
    url: `${base}/${page.slug}`,
    lastModified: page.updatedAt ?? undefined,
  }));


  // Campaign pages: only live, published rows that opted into indexing
  // (noindex is the default, so most campaigns stay out).
  const landingPageEntries: MetadataRoute.Sitemap = landingPages.map((page) => ({
    url: `${base}/go/${page.slug}`,
    lastModified: page.updatedAt ?? undefined,
  }));


  return [...staticEntries, ...guideEntries, ...fieldNoteEntries, ...courseEntries, ...pageEntries, ...landingPageEntries];
}
