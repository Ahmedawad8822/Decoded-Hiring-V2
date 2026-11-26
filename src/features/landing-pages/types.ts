import { z } from "zod";

import { slugSchema } from "@/features/publishing/types";
import type { ContentStatus } from "@/features/publishing/types";

// ============================================================================
// LANDING PAGE TYPES (§4 PAGE-TYPE-SPECS)
// ----------------------------------------------------------------------------
// Campaign conversion pages at /go/[slug]. Sections are built ONLY from the
// approved reusable blocks below — unknown block types are rejected by the
// discriminated union. The "target summary" block carries no author content:
// it renders live data from the linked target at request time.
// ============================================================================

export type LandingPageStatus = ContentStatus;
export type LandingPageTargetKind = "offer" | "course" | "guide";

export const LANDING_PAGE_TARGET_KINDS = ["offer", "course", "guide"] as const;

const blockId = z.string().min(1).max(80);

export const landingHeroBlockSchema = z.object({
  id: blockId,
  type: z.literal("hero"),
  kicker: z.string().trim().max(120).optional(),
  heading: z.string().trim().min(3).max(160),
  subheading: z.string().trim().max(500).optional(),
});

export const landingProblemBlockSchema = z.object({
  id: blockId,
  type: z.literal("problem"),
  heading: z.string().trim().min(3).max(160),
  points: z.array(z.string().trim().min(3).max(300)).min(1).max(8),
});

export const landingBenefitsBlockSchema = z.object({
  id: blockId,
  type: z.literal("benefits"),
  heading: z.string().trim().min(3).max(160),
  items: z
    .array(
      z.object({
        title: z.string().trim().min(3).max(120),
        text: z.string().trim().min(3).max(500),
      }),
    )
    .min(1)
    .max(8),
});

export const landingQuoteBlockSchema = z.object({
  id: blockId,
  type: z.literal("quote"),
  text: z.string().trim().min(3).max(800),
  attribution: z.string().trim().max(160).optional(),
});

export const landingTargetSummaryBlockSchema = z.object({
  id: blockId,
  type: z.literal("target_summary"),
  heading: z.string().trim().max(160).optional(),
});

export const landingFaqBlockSchema = z.object({
  id: blockId,
  type: z.literal("faq"),
  heading: z.string().trim().max(160).optional(),
  items: z
    .array(
      z.object({
        q: z.string().trim().min(3).max(200),
        a: z.string().trim().min(3).max(1200),
      }),
    )
    .min(1)
    .max(12),
});

export const landingCtaBandBlockSchema = z.object({
  id: blockId,
  type: z.literal("cta_band"),
  heading: z.string().trim().min(3).max(160),
  text: z.string().trim().max(500).optional(),
  ctaLabel: z.string().trim().min(2).max(80).optional(),
});

export const landingLeadFormBlockSchema = z.object({
  id: blockId,
  type: z.literal("lead_form"),
  heading: z.string().trim().min(3).max(160),
  text: z.string().trim().max(500).optional(),
});

export const landingSectionSchema = z.discriminatedUnion("type", [
  landingHeroBlockSchema,
  landingProblemBlockSchema,
  landingBenefitsBlockSchema,
  landingQuoteBlockSchema,
  landingTargetSummaryBlockSchema,
  landingFaqBlockSchema,
  landingCtaBandBlockSchema,
  landingLeadFormBlockSchema,
]);

export type LandingPageSection = z.infer<typeof landingSectionSchema>;

export const LANDING_PAGE_BLOCK_TYPES = [
  "hero",
  "problem",
  "benefits",
  "quote",
  "target_summary",
  "faq",
  "cta_band",
  "lead_form",
] as const;

export type LandingPageBlockType = (typeof LANDING_PAGE_BLOCK_TYPES)[number];

export const landingSectionsSchema = z
  .array(landingSectionSchema)
  .max(20)
  .superRefine((sections, ctx) => {
    // One lead form is enough: a second form on the same page splits
    // attribution without adding signal.
    const leadForms = sections.filter((s) => s.type === "lead_form").length;
    if (leadForms > 1) {
      ctx.addIssue({
        code: "custom",
        message: "A landing page can contain at most one lead form block.",
      });
    }
  });

const optionalDate = z.preprocess(
  (value) => {
    if (value == null || value === "") return null;
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed;
    }
    return value;
  },
  z.date().nullable().optional(),
);

const targetRefinement = (
  value: { targetKind: LandingPageTargetKind; targetOfferId?: string | null; targetCourseId?: string | null; targetGuideId?: string | null },
  ctx: z.RefinementCtx,
) => {
  const picked = [value.targetOfferId, value.targetCourseId, value.targetGuideId].filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  if (picked.length !== 1) {
    ctx.addIssue({
      code: "custom",
      message: "A landing page must link to exactly one target: one offer, course or guide.",
    });
    return;
  }
  const expected =
    value.targetKind === "offer"
      ? value.targetOfferId
      : value.targetKind === "course"
        ? value.targetCourseId
        : value.targetGuideId;
  if (!expected) {
    ctx.addIssue({
      code: "custom",
      message: `Target kind is "${value.targetKind}" but the linked ${value.targetKind} is missing.`,
    });
  }
};

// Base object carries no refinements so `.partial()` stays available for the
// update schema (zod v4 rejects .partial() on refined objects). Create keeps
// the full shape checks; update validates the merged row in the service,
// where the untouched half of a target switch is visible.
const landingPageBaseSchema = z.object({
  title: z.string().trim().min(3, "Title must be at least 3 characters").max(200),
  slug: slugSchema,
  campaignName: z.string().trim().min(2).max(120),
  targetKind: z.enum(LANDING_PAGE_TARGET_KINDS),
  targetOfferId: z.string().trim().min(1).max(80).nullable().optional(),
  targetCourseId: z.string().trim().min(1).max(80).nullable().optional(),
  targetGuideId: z.string().trim().min(1).max(80).nullable().optional(),
  ctaLabel: z.string().trim().min(2).max(80),
  sections: landingSectionsSchema.default([]),
  seoTitle: z.string().trim().max(100).nullable().optional(),
  seoDescription: z.string().trim().max(300).nullable().optional(),
  noindex: z.boolean().default(true),
  startsAt: optionalDate,
  endsAt: optionalDate,
});

export const createLandingPageSchema = landingPageBaseSchema
  .superRefine((value, ctx) => {
    targetRefinement(value, ctx);
    if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "The end date must be after the start date.",
      });
    }
  });

export const updateLandingPageSchema = landingPageBaseSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateLandingPageInput = z.infer<typeof createLandingPageSchema>;
export type UpdateLandingPageInput = z.infer<typeof updateLandingPageSchema>;

// ----------------------------------------------------------------------------
// Schedule states (public route + cron share this)
// ----------------------------------------------------------------------------

export type LandingPageScheduleState = "scheduled" | "live" | "ended";

export function getLandingScheduleState(
  page: { startsAt: Date | null; endsAt: Date | null },
  now: Date = new Date(),
): LandingPageScheduleState {
  if (page.startsAt && now < page.startsAt) return "scheduled";
  if (page.endsAt && now >= page.endsAt) return "ended";
  return "live";
}

// ----------------------------------------------------------------------------
// UTM pass-through (pure helpers; the public page stays cacheable because
// UTMs are read client-side and only appended to CTA hrefs + lead fields)
// ----------------------------------------------------------------------------

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

export type UtmParams = Partial<Record<(typeof UTM_KEYS)[number], string>>;

export function parseUtmParams(
  input: URLSearchParams | Record<string, string | string[] | undefined>,
): UtmParams {
  const result: UtmParams = {};
  const get = (key: string): string | undefined => {
    if (input instanceof URLSearchParams) return input.get(key) ?? undefined;
    const value = input[key];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const key of UTM_KEYS) {
    const raw = get(key)?.trim().slice(0, 80);
    if (raw) result[key] = raw;
  }
  return result;
}

/** Append known UTM params to a same-site href, preserving existing query. */
export function appendUtmsToHref(href: string, utms: UtmParams): string {
  const entries = Object.entries(utms).filter(([, v]) => Boolean(v)) as [string, string][];
  if (entries.length === 0) return href;
  const hashIndex = href.indexOf("#");
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const separator = base.includes("?") ? "&" : "?";
  const query = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${base}${separator}${query}${hash}`;
}

/** Small JSON payload stored on the lead row (keys + values already bounded). */
export function serializeUtmParams(utms: UtmParams): string | null {
  const entries = Object.entries(utms).filter(([, v]) => Boolean(v));
  if (entries.length === 0) return null;
  return JSON.stringify(Object.fromEntries(entries));
}
