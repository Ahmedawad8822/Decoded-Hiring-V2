import { and, asc, desc, eq, isNotNull, isNull, lte, ne } from "drizzle-orm";

import {
  courses,
  getDb,
  guides,
  landingPages,
  offers,
  type LandingPage,
} from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import { AppError } from "@/lib/errors";
import {
  buildArchiveUpdate,
  buildEditTouch,
  buildPublishUpdate,
  buildUnpublishUpdate,
} from "@/features/publishing/lifecycle";
import { resolveOfferPublicPresentation } from "@/features/offers/presentation";
import { recordAdminAudit } from "@/features/audit/service";
import {
  createLandingPageSchema,
  getLandingScheduleState,
  updateLandingPageSchema,
  type CreateLandingPageInput,
  type LandingPageScheduleState,
  type UpdateLandingPageInput,
} from "./types";

// ============================================================================
// LANDING PAGE SERVICE (§4 PAGE-TYPE-SPECS + §1 lifecycle)
// ----------------------------------------------------------------------------
// Explicit per-domain DB access. Trash is a flag, not a status: every normal
// read filters trashed rows out; only the Trash registry (used by the shared
// Trash page the coordinator wires) lists them.
// ============================================================================

const TRASH_RETENTION_DAYS = 30;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function newId(): string {
  return `lp_${crypto.randomUUID().slice(0, 12)}`;
}

// ---------------------------------------------------------------- Admin reads

/** Every normal Studio list hides trashed rows. */
export async function getAllAdminLandingPages(): Promise<LandingPage[]> {
  const db = await getDb();
  return db
    .select()
    .from(landingPages)
    .where(isNull(landingPages.trashedAt))
    .orderBy(desc(landingPages.updatedAt));
}

export async function getAdminLandingPageById(id: string): Promise<LandingPage | null> {
  const db = await getDb();
  return (await db.select().from(landingPages).where(eq(landingPages.id, id)).get()) ?? null;
}

export async function getAdminLandingPageBySlug(slug: string): Promise<LandingPage | null> {
  const db = await getDb();
  return (await db.select().from(landingPages).where(eq(landingPages.slug, slug)).get()) ?? null;
}

/** Trash registry: type, title, trashed date (the shared Trash page renders days left). */
export async function listTrashedLandingPages(): Promise<LandingPage[]> {
  const db = await getDb();
  return db
    .select()
    .from(landingPages)
    .where(isNotNull(landingPages.trashedAt))
    .orderBy(desc(landingPages.trashedAt));
}

// --------------------------------------------------------------- Public reads

export type ResolvedPublicLandingPage = {
  page: LandingPage;
  scheduleState: Extract<LandingPageScheduleState, "live" | "ended">;
};

/**
 * Public resolver for /go/[slug]. Before starts_at (or draft / archived /
 * trashed) the route 404s; after ends_at it renders the ended state with a
 * link to the target until the cron archives it.
 */
export async function resolvePublicLandingPage(
  slug: string,
  now: Date = new Date(),
): Promise<ResolvedPublicLandingPage | null> {
  const db = await getDb();
  const page = await db.select().from(landingPages).where(eq(landingPages.slug, slug)).get();
  if (!page) return null;
  if (page.trashedAt !== null) return null;
  if (page.status !== "published") return null;
  const state = getLandingScheduleState(page, now);
  if (state === "scheduled") return null;
  return { page, scheduleState: state };
}

/** Sitemap: only live, non-trashed, published pages that opted into indexing. */
export async function getSitemapLandingPages(now: Date = new Date()): Promise<LandingPage[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(landingPages)
    .where(
      and(
        eq(landingPages.status, "published"),
        isNull(landingPages.trashedAt),
        eq(landingPages.noindex, false),
      ),
    )
    .orderBy(desc(landingPages.updatedAt));
  return rows.filter((row) => getLandingScheduleState(row, now) === "live");
}

// ------------------------------------------------------------------ Targets

export type LandingTargetSummary = {
  kind: "offer" | "course" | "guide";
  id: string;
  title: string;
  description: string | null;
  href: string;
  badge: string | null;
  priceLabel: string | null;
  outcomes: string[];
};

function parseOutcomes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

async function assertTargetUsable(input: {
  targetKind: "offer" | "course" | "guide";
  targetOfferId?: string | null;
  targetCourseId?: string | null;
  targetGuideId?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (input.targetKind === "offer") {
    const offer = await db
      .select()
      .from(offers)
      .where(eq(offers.id, input.targetOfferId ?? ""))
      .get();
    if (!offer) throw new AppError("not_found", "Linked offer not found.");
    if (!offer.active) {
      throw new AppError("invalid", "Linked offer is inactive, so the CTA would be dead.");
    }
    return;
  }
  if (input.targetKind === "course") {
    const course = await db
      .select()
      .from(courses)
      .where(eq(courses.id, input.targetCourseId ?? ""))
      .get();
    if (!course) throw new AppError("not_found", "Linked course not found.");
    if (course.status !== "published") {
      throw new AppError("invalid", "Linked course is not published, so the CTA would be dead.");
    }
    return;
  }
  const guide = await db
    .select()
    .from(guides)
    .where(eq(guides.id, input.targetGuideId ?? ""))
    .get();
  if (!guide) throw new AppError("not_found", "Linked guide not found.");
  if (guide.status !== "published") {
    throw new AppError("invalid", "Linked guide is not published, so the CTA would be dead.");
  }
}

/**
 * Live target data for the "target summary" block plus the CTA href. The CTA
 * href comes from the target's public URL: the course sales page
 * (/courses/[slug]), the guide page (/guides/[slug]), or the offer's public
 * presentation link.
 */
export async function resolveTargetSummary(page: LandingPage): Promise<LandingTargetSummary | null> {
  const db = await getDb();
  if (page.targetKind === "offer" && page.targetOfferId) {
    const offer = await db.select().from(offers).where(eq(offers.id, page.targetOfferId)).get();
    if (!offer) return null;
    if (!offer.active) return null;
    let href = "/contact";
    if (offer.kind === "COACHING") href = "/coaching";
    else if (offer.kind === "WORKSHOP") href = "/workshop";
    else if (offer.kind === "COURSE" && offer.courseId) {
      const course = await db.select().from(courses).where(eq(courses.id, offer.courseId)).get();
      if (!course || course.status !== "published") return null;
      href = `/courses/${course.slug}`;
    } else {
      href = offer.alternativeCtaUrl ?? "/contact";
    }
    const presentation = resolveOfferPublicPresentation(offer, { freeHref: href });
    return {
      kind: "offer",
      id: offer.id,
      title: offer.title,
      description: null,
      href: presentation.ctaHref ?? href,
      badge: presentation.badge,
      priceLabel: presentation.priceLabel,
      outcomes: [],
    };
  }
  if (page.targetKind === "course" && page.targetCourseId) {
    const course = await db.select().from(courses).where(eq(courses.id, page.targetCourseId)).get();
    if (!course) return null;
    if (course.status !== "published") return null;
    return {
      kind: "course",
      id: course.id,
      title: course.title,
      description: course.description,
      href: `/courses/${course.slug}`,
      badge: null,
      priceLabel: null,
      outcomes: parseOutcomes(course.outcomes),
    };
  }
  if (page.targetKind === "guide" && page.targetGuideId) {
    const guide = await db.select().from(guides).where(eq(guides.id, page.targetGuideId)).get();
    if (!guide) return null;
    if (guide.status !== "published") return null;
    return {
      kind: "guide",
      id: guide.id,
      title: guide.title,
      description: guide.excerpt,
      href: `/guides/${guide.slug}`,
      badge: null,
      priceLabel: null,
      outcomes: [],
    };
  }
  return null;
}

// ------------------------------------------------------------------ Mutations

async function friendlySlugConflict(db: Awaited<ReturnType<typeof getDb>>, slug: string, excludeId?: string) {
  const rows = await db.select({ id: landingPages.id }).from(landingPages).where(eq(landingPages.slug, slug));
  return rows.some((row) => row.id !== excludeId);
}

export async function createLandingPage(input: CreateLandingPageInput): Promise<LandingPage> {
  const parsed = createLandingPageSchema.parse(input);
  await assertTargetUsable(parsed);
  const db = await getDb();

  const existing = await db.select({ id: landingPages.id }).from(landingPages).where(eq(landingPages.slug, parsed.slug)).get();
  if (existing) {
    throw new AppError("conflict", `A landing page with the slug "${parsed.slug}" already exists.`);
  }

  const now = new Date();
  const id = newId();
  try {
    await db.insert(landingPages).values({
      id,
      title: parsed.title,
      slug: parsed.slug,
      campaignName: parsed.campaignName,
      targetKind: parsed.targetKind,
      targetOfferId: parsed.targetOfferId ?? null,
      targetCourseId: parsed.targetCourseId ?? null,
      targetGuideId: parsed.targetGuideId ?? null,
      ctaLabel: parsed.ctaLabel,
      sections: JSON.stringify(parsed.sections),
      seoTitle: parsed.seoTitle ?? null,
      seoDescription: parsed.seoDescription ?? null,
      noindex: parsed.noindex,
      status: "draft",
      startsAt: parsed.startsAt ?? null,
      endsAt: parsed.endsAt ?? null,
      trashedAt: null,
      trashedFromStatus: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    }).run();
  } catch (error: unknown) {
    if (!isUniqueConstraintError(error)) throw error;
    if (!(await friendlySlugConflict(db, parsed.slug))) throw error;
    throw new AppError("conflict", `A landing page with the slug "${parsed.slug}" already exists.`);
  }

  const created = await getAdminLandingPageById(id);
  if (!created) throw new Error("Failed to retrieve created landing page");
  return created;
}

export async function updateLandingPage(id: string, input: UpdateLandingPageInput): Promise<LandingPage> {
  const parsed = updateLandingPageSchema.parse({ ...input, id });
  const db = await getDb();
  const current = await getAdminLandingPageById(id);
  if (!current) throw new AppError("not_found", `Landing page with id "${id}" not found`);
  if (current.trashedAt !== null) {
    throw new AppError("invalid", "This page is in Trash. Restore it before editing.");
  }

  if (parsed.slug && parsed.slug !== current.slug) {
    const conflict = await db
      .select({ id: landingPages.id })
      .from(landingPages)
      .where(and(eq(landingPages.slug, parsed.slug), ne(landingPages.id, id)))
      .get();
    if (conflict) {
      throw new AppError("conflict", `A landing page with the slug "${parsed.slug}" already exists.`);
    }
  }

  // Target changes re-validate liveness so the CTA never goes dead silently.
  // The merged row (not just the patch) is checked: exactly one target, the
  // id matching the kind, and a sane schedule.
  const nextKind = parsed.targetKind ?? current.targetKind;
  const nextOffer = parsed.targetOfferId !== undefined ? parsed.targetOfferId : current.targetOfferId;
  const nextCourse = parsed.targetCourseId !== undefined ? parsed.targetCourseId : current.targetCourseId;
  const nextGuide = parsed.targetGuideId !== undefined ? parsed.targetGuideId : current.targetGuideId;
  if (
    parsed.targetKind !== undefined ||
    parsed.targetOfferId !== undefined ||
    parsed.targetCourseId !== undefined ||
    parsed.targetGuideId !== undefined ||
    parsed.startsAt !== undefined ||
    parsed.endsAt !== undefined
  ) {
    const picked = [nextOffer, nextCourse, nextGuide].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (picked.length !== 1) {
      throw new AppError("invalid", "A landing page must link to exactly one target: one offer, course or guide.");
    }
    const expected =
      nextKind === "offer" ? nextOffer : nextKind === "course" ? nextCourse : nextGuide;
    if (!expected) {
      throw new AppError("invalid", `Target kind is "${nextKind}" but the linked ${nextKind} is missing.`);
    }
    const nextStarts = parsed.startsAt !== undefined ? parsed.startsAt : current.startsAt;
    const nextEnds = parsed.endsAt !== undefined ? parsed.endsAt : current.endsAt;
    if (nextStarts && nextEnds && nextEnds <= nextStarts) {
      throw new AppError("invalid", "The end date must be after the start date.");
    }
    await assertTargetUsable({
      targetKind: nextKind,
      targetOfferId: nextOffer,
      targetCourseId: nextCourse,
      targetGuideId: nextGuide,
    });
  }

  const now = new Date();
  const updateData: Partial<typeof landingPages.$inferInsert> = { ...buildEditTouch(now) };
  if (parsed.title !== undefined) updateData.title = parsed.title;
  if (parsed.slug !== undefined) updateData.slug = parsed.slug;
  if (parsed.campaignName !== undefined) updateData.campaignName = parsed.campaignName;
  if (parsed.targetKind !== undefined) updateData.targetKind = parsed.targetKind;
  if (parsed.targetOfferId !== undefined) updateData.targetOfferId = parsed.targetOfferId;
  if (parsed.targetCourseId !== undefined) updateData.targetCourseId = parsed.targetCourseId;
  if (parsed.targetGuideId !== undefined) updateData.targetGuideId = parsed.targetGuideId;
  if (parsed.ctaLabel !== undefined) updateData.ctaLabel = parsed.ctaLabel;
  if (parsed.sections !== undefined) updateData.sections = JSON.stringify(parsed.sections);
  if (parsed.seoTitle !== undefined) updateData.seoTitle = parsed.seoTitle ?? null;
  if (parsed.seoDescription !== undefined) updateData.seoDescription = parsed.seoDescription ?? null;
  if (parsed.noindex !== undefined) updateData.noindex = parsed.noindex;
  if (parsed.startsAt !== undefined) updateData.startsAt = parsed.startsAt;
  if (parsed.endsAt !== undefined) updateData.endsAt = parsed.endsAt;

  try {
    // Campaign slugs are never renamed for SEO: no slug-redirect row is
    // recorded, unlike guides/field notes.
    await db.update(landingPages).set(updateData).where(eq(landingPages.id, id)).run();
  } catch (error: unknown) {
    if (!isUniqueConstraintError(error)) throw error;
    if (!(await friendlySlugConflict(db, updateData.slug ?? current.slug, id))) throw error;
    throw new AppError("conflict", `A landing page with the slug "${parsed.slug}" already exists.`);
  }

  const updated = await getAdminLandingPageById(id);
  if (!updated) throw new Error("Failed to retrieve updated landing page");
  return updated;
}

// ------------------------------------------------------------- Lifecycle (§1)

function assertLandingTransition(from: LandingPage["status"], action: "publish" | "unpublish" | "archive" | "restore"): void {
  const allowed: Record<LandingPage["status"], string[]> = {
    draft: ["publish", "archive"],
    published: ["unpublish", "archive"],
    // Unlike guides/field notes (archived is terminal there), §1 restores an
    // archived landing page back to draft — never straight to published.
    archived: ["restore"],
  };
  if (!allowed[from].includes(action)) {
    throw new AppError("invalid", `Cannot ${action} a landing page with status "${from}".`);
  }
}

async function setStatus(id: string, update: Partial<typeof landingPages.$inferInsert>): Promise<LandingPage> {
  const db = await getDb();
  await db.update(landingPages).set(update).where(eq(landingPages.id, id)).run();
  const next = await getAdminLandingPageById(id);
  if (!next) throw new Error("Failed to retrieve landing page");
  return next;
}

export async function publishLandingPage(id: string): Promise<LandingPage> {
  const current = await getAdminLandingPageById(id);
  if (!current) throw new AppError("not_found", `Landing page with id "${id}" not found`);
  if (current.trashedAt !== null) throw new AppError("invalid", "This page is in Trash. Restore it first.");
  assertLandingTransition(current.status, "publish");
  await assertTargetUsable(current);
  return setStatus(id, buildPublishUpdate({ publishedAt: current.publishedAt }, new Date()));
}

export async function unpublishLandingPage(id: string): Promise<LandingPage> {
  const current = await getAdminLandingPageById(id);
  if (!current) throw new AppError("not_found", `Landing page with id "${id}" not found`);
  if (current.trashedAt !== null) throw new AppError("invalid", "This page is in Trash. Restore it first.");
  assertLandingTransition(current.status, "unpublish");
  return setStatus(id, buildUnpublishUpdate(new Date()));
}

export async function archiveLandingPage(id: string): Promise<LandingPage> {
  const current = await getAdminLandingPageById(id);
  if (!current) throw new AppError("not_found", `Landing page with id "${id}" not found`);
  if (current.trashedAt !== null) throw new AppError("invalid", "This page is in Trash. Restore it first.");
  assertLandingTransition(current.status, "archive");
  return setStatus(id, buildArchiveUpdate(new Date()));
}

export async function restoreArchivedLandingPage(id: string): Promise<LandingPage> {
  const current = await getAdminLandingPageById(id);
  if (!current) throw new AppError("not_found", `Landing page with id "${id}" not found`);
  if (current.trashedAt !== null) throw new AppError("invalid", "This page is in Trash. Restore it from Trash instead.");
  assertLandingTransition(current.status, "restore");
  const db = await getDb();
  const now = new Date();
  await db.update(landingPages).set({ status: "draft", updatedAt: now }).where(eq(landingPages.id, id)).run();
  return (await getAdminLandingPageById(id))!;
}

// ------------------------------------------------------------------- Trash

export async function moveLandingPageToTrash(id: string): Promise<LandingPage> {
  const current = await getAdminLandingPageById(id);
  if (!current) throw new AppError("not_found", `Landing page with id "${id}" not found`);
  if (current.trashedAt !== null) throw new AppError("invalid", "This page is already in Trash.");
  // Published pages carry live campaign traffic: unpublish or archive first.
  if (current.status === "published") {
    throw new AppError("invalid", "Unpublish or archive this page before moving it to Trash.");
  }
  const db = await getDb();
  const now = new Date();
  await db
    .update(landingPages)
    .set({ trashedAt: now, trashedFromStatus: current.status, updatedAt: now })
    .where(eq(landingPages.id, id))
    .run();
  return (await getAdminLandingPageById(id))!;
}

export async function restoreLandingPageFromTrash(id: string, actorId: string): Promise<LandingPage> {
  const current = await getAdminLandingPageById(id);
  if (!current) throw new AppError("not_found", `Landing page with id "${id}" not found`);
  if (current.trashedAt === null) throw new AppError("invalid", "This page is not in Trash.");
  const db = await getDb();
  await db
    .update(landingPages)
    .set({
      status: current.trashedFromStatus ?? "draft",
      trashedAt: null,
      trashedFromStatus: null,
      updatedAt: new Date(),
    })
    .where(eq(landingPages.id, id))
    .run();
  const restored = (await getAdminLandingPageById(id))!;
  await recordAdminAudit({
    actorId,
    action: "landing_page.restore_from_trash",
    entityType: "landing_page",
    entityId: id,
    details: { slug: restored.slug, status: restored.status },
  });
  return restored;
}

/**
 * Irreversible. Only from Trash, with the title typed as confirmation.
 * Landing pages own no learner data: permanent delete removes the row (slugs
 * of trashed rows stay reserved until this point) and writes an audit row
 * with a snapshot. Leads keep their plain-text landing_page_id attribution.
 */
export async function deleteLandingPagePermanently(
  id: string,
  actorId: string,
  confirmTitle: string,
): Promise<void> {
  const current = await getAdminLandingPageById(id);
  if (!current) throw new AppError("not_found", `Landing page with id "${id}" not found`);
  if (current.trashedAt === null) {
    throw new AppError("invalid", "Only pages in Trash can be permanently deleted. Move it to Trash first.");
  }
  if (confirmTitle.trim() !== current.title) {
    throw new AppError("invalid", "Type the exact page title to confirm permanent deletion.");
  }
  const db = await getDb();
  await db.delete(landingPages).where(eq(landingPages.id, id)).run();
  await recordAdminAudit({
    actorId,
    action: "landing_page.delete_permanently",
    entityType: "landing_page",
    entityId: id,
    details: { title: current.title, slug: current.slug, status: current.status },
  });
}

/**
 * 5-minute cron backstop (wired by the coordinator): permanently delete
 * trashed rows older than 30 days in small bounded batches. Landing pages
 * have no learner-data dependency checks; rows that disappear mid-batch
 * (deleted by an admin) are simply skipped.
 */
export async function purgeExpiredLandingPages(now: Date, limit = 20): Promise<string[]> {
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_MS);
  const db = await getDb();
  const expired = await db
    .select({ id: landingPages.id })
    .from(landingPages)
    .where(lte(landingPages.trashedAt, cutoff))
    .orderBy(asc(landingPages.trashedAt))
    .limit(bounded);
  const purged: string[] = [];
  for (const row of expired) {
    const current = await getAdminLandingPageById(row.id);
    if (!current || current.trashedAt === null) continue;
    if (current.trashedAt > cutoff) continue;
    await db.delete(landingPages).where(eq(landingPages.id, row.id)).run();
    await recordAdminAudit({
      actorId: "cron",
      action: "landing_page.auto_purge",
      entityType: "landing_page",
      entityId: row.id,
      details: { title: current.title, slug: current.slug, status: current.status },
    });
    purged.push(row.id);
  }
  return purged;
}

/**
 * Schedule cron (wired by the coordinator): published, non-trashed campaigns
 * past ends_at move to archived so the public route stops listing them as
 * live. Bounded batch; returns the archived ids.
 */
export async function archiveEndedCampaigns(now: Date, limit = 50): Promise<string[]> {
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const db = await getDb();
  const ended = await db
    .select({ id: landingPages.id })
    .from(landingPages)
    .where(
      and(
        eq(landingPages.status, "published"),
        isNull(landingPages.trashedAt),
        lte(landingPages.endsAt, now),
      ),
    )
    .orderBy(asc(landingPages.endsAt))
    .limit(bounded);
  const archived: string[] = [];
  for (const row of ended) {
    const current = await getAdminLandingPageById(row.id);
    if (!current || current.status !== "published" || current.trashedAt !== null) continue;
    await db.update(landingPages).set(buildArchiveUpdate(now)).where(eq(landingPages.id, row.id)).run();
    await recordAdminAudit({
      actorId: "cron",
      action: "landing_page.archive_ended",
      entityType: "landing_page",
      entityId: row.id,
      details: { title: current.title, slug: current.slug },
    });
    archived.push(row.id);
  }
  return archived;
}
