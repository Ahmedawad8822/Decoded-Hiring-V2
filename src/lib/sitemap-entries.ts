import type { MetadataRoute } from "next";
import { staticRoutes } from "./public-routes";
export { staticRoutes } from "./public-routes";
import { getSiteUrl } from "@/lib/seo";
import { getPublishedGuides } from "@/features/guides/service";
import { getPublishedFieldNotes } from "@/features/field-notes/service";
import { getPublicCourses } from "@/features/courses/sales";

// ============================================================================
// SITEMAP ENTRIES — remediation B.2/B.4
// ----------------------------------------------------------------------------
// Single source of truth for sitemap content, shared by src/app/sitemap.ts
// and the regression suite. Static public marketing routes plus the canonical
// URLs of PUBLISHED guides, field notes and courses only. Drafts, archived
// and trashed content
// can never appear: the source queries filter on status = 'published' at the
// service layer, and tests assert draft/archived slugs stay out.
// Static routes omit lastModified (stable timestamp unknown); dynamic content
// uses updatedAt. Adds max-image-preview: large via robots (not sitemap).
// ============================================================================

export async function buildSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const base = getSiteUrl().toString().replace(/\/$/, "");

  const [guides, fieldNotes, courses] = await Promise.all([
    getPublishedGuides(),
    getPublishedFieldNotes(),
    getPublicCourses(),
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

  return [...staticEntries, ...guideEntries, ...fieldNoteEntries, ...courseEntries];
}
