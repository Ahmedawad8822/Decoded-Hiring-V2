import { z } from "zod";

export const homeSectionKinds = [
  "hero",
  "proof",
  "principle",
  "paths",
  "lab",
  "mission",
  "workshop",
  "coaching",
  "os",
  "testimonials",
  "contact",
  "callout",
] as const;

export const homeSectionSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
    kind: z.enum(homeSectionKinds),
    enabled: z.boolean(),
    kicker: z.string().trim().max(120).default(""),
    title: z.string().trim().max(180).default(""),
    body: z.string().trim().max(1200).default(""),
    buttonLabel: z.string().trim().max(80).default(""),
    imageAssetId: z.union([z.uuid(), z.literal("")]).default(""),
    href: z
      .string()
      .max(200)
      .refine(
        (value) =>
          value === "" ||
          (value === value.trim() &&
            /^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?(?:#[a-z0-9_-]+)?$/.test(
              value,
            )),
        "Use a local website path, such as /workshop.",
      )
      .default(""),
  })
  .strict();

export const homeSectionsSchema = z
  .array(homeSectionSchema)
  .min(1)
  .max(24)
  .superRefine((sections, ctx) => {
    if (new Set(sections.map((s) => s.key)).size !== sections.length)
      ctx.addIssue({ code: "custom", message: "Section keys must be unique." });
    const fixed = sections.filter((s) => s.kind !== "callout");
    if (new Set(fixed.map((s) => s.kind)).size !== fixed.length)
      ctx.addIssue({
        code: "custom",
        message: "Each original section can appear once.",
      });
    if (sections[0]?.kind !== "hero" || !sections[0]?.enabled)
      ctx.addIssue({
        code: "custom",
        message: "Keep the hero visible and first.",
      });
    for (const s of sections) {
      if (
        s.kind === "callout" &&
        (!s.title || !s.body || !s.buttonLabel || !s.href)
      )
        ctx.addIssue({
          code: "custom",
          message: "New callouts need a title, summary and action.",
        });
      if (Boolean(s.buttonLabel) !== Boolean(s.href))
        ctx.addIssue({
          code: "custom",
          message: "Action label and destination must be provided together.",
        });
    }
  });

export type PersistedHomeSection = z.infer<typeof homeSectionSchema>;
export type HomeSection = PersistedHomeSection & { imageSrc?: string };
export const defaultHomeSections: HomeSection[] = homeSectionKinds
  .filter((kind) => kind !== "callout")
  .map((kind) => ({
    key: kind,
    kind,
    enabled: true,
    kicker: "",
    title: "",
    body: "",
    buttonLabel: "",
    imageAssetId: "",
    href: "",
  }));

export const editableHomeCopy = new Set([
  "hero",
  "mission",
  "workshop",
  "coaching",
  "os",
  "contact",
  "callout",
]);
