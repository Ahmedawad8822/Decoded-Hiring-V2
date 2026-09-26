import { and, desc, eq, inArray, ne } from "drizzle-orm";

import {
  bookingTypes,
  courses,
  offers,
  type Course,
  type CourseAccessMode,
  type Offer,
  type OfferAccessMode,
} from "@/lib/db";
import { getDb } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";
import {
  createOfferSchema,
  updateOfferSchema,
  type CreateOfferInput,
  type UpdateOfferInput,
} from "./types";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

type ValidatedOfferInput = {
  kind: Offer["kind"];
  courseId: string | null;
  bookingTypeId: string | null;
  title: string;
  slug: string;
  accessMode: OfferAccessMode;
  currency: string | null;
  amountMinor: number | null;
  alternativeCtaLabel: string | null;
  alternativeCtaUrl: string | null;
  active: boolean;
};

function normalizeOfferInput(input: {
  kind: Offer["kind"];
  courseId?: string | null;
  bookingTypeId?: string | null;
  title: string;
  slug: string;
  accessMode: OfferAccessMode;
  currency?: string | null;
  amountMinor?: number | null;
  alternativeCtaLabel?: string | null;
  alternativeCtaUrl?: string | null;
  active?: boolean;
}): ValidatedOfferInput {
  const value: ValidatedOfferInput = {
    kind: input.kind,
    courseId: input.courseId ?? null,
    bookingTypeId: input.bookingTypeId ?? null,
    title: input.title.trim(),
    slug: input.slug.trim(),
    accessMode: input.accessMode,
    currency: input.currency?.trim() || null,
    amountMinor: input.amountMinor ?? null,
    alternativeCtaLabel: input.alternativeCtaLabel?.trim() || null,
    alternativeCtaUrl: input.alternativeCtaUrl?.trim() || null,
    active: input.active ?? true,
  };

  if (value.kind === "COURSE") {
    if (!value.courseId) {
      throw new Error("COURSE offers must link to a course.");
    }
    if (value.bookingTypeId) {
      throw new Error("COURSE offers cannot also link to a booking type.");
    }
    if (value.accessMode === "PAID_SESSION") {
      throw new Error("COURSE offers cannot use PAID_SESSION access.");
    }
  } else if (value.kind === "COACHING" || value.kind === "WORKSHOP") {
    if (value.courseId) {
      throw new Error(`${value.kind} offers cannot link to a course.`);
    }
  } else if (value.courseId || value.bookingTypeId) {
    throw new Error("Standalone PRODUCT offers cannot link to a course or booking type.");
  }

  const isProviderPaid =
    value.accessMode === "PAID_ONE_TIME" || value.accessMode === "PAID_SESSION";
  if (isProviderPaid) {
    if (!value.currency || value.amountMinor == null || value.amountMinor <= 0) {
      throw new Error(
        `${value.accessMode} offers require a currency and a positive amountMinor.`,
      );
    }
  }

  if (value.amountMinor != null && value.amountMinor > 0 && !value.currency) {
    throw new Error("An offer with an amount requires a currency.");
  }

  if (value.accessMode === "FREE" && value.amountMinor != null && value.amountMinor !== 0) {
    throw new Error("FREE offers cannot carry a non-zero amount.");
  }

  const hasAlternativeLabel = Boolean(value.alternativeCtaLabel);
  const hasAlternativeUrl = Boolean(value.alternativeCtaUrl);
  if (hasAlternativeLabel !== hasAlternativeUrl) {
    throw new Error("Alternative CTA label and URL must be configured together.");
  }

  if (
    (value.accessMode === "PAYMENT_DISABLED" || value.accessMode === "COMING_SOON") &&
    (!hasAlternativeLabel || !hasAlternativeUrl)
  ) {
    throw new Error(
      `${value.accessMode} offers require an alternative CTA label and URL so public pages never render a dead checkout action.`,
    );
  }

  return value;
}

async function assertLinkedEntities(input: ValidatedOfferInput): Promise<void> {
  const db = await getDb();
  if (input.courseId) {
    const course = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, input.courseId)).get();
    if (!course) throw new Error("Linked course not found.");
  }
  if (input.bookingTypeId) {
    const bookingType = await db
      .select({ id: bookingTypes.id })
      .from(bookingTypes)
      .where(eq(bookingTypes.id, input.bookingTypeId))
      .get();
    if (!bookingType) throw new Error("Linked booking type not found.");
  }
}

export async function getOfferById(id: string): Promise<Offer | null> {
  const db = await getDb();
  return (await db.select().from(offers).where(eq(offers.id, id)).get()) ?? null;
}

export async function getOfferBySlug(slug: string): Promise<Offer | null> {
  const db = await getDb();
  return (await db.select().from(offers).where(eq(offers.slug, slug)).get()) ?? null;
}

export async function getPublicOfferBySlug(slug: string): Promise<Offer | null> {
  const db = await getDb();
  return (
    (await db
      .select()
      .from(offers)
      .where(and(eq(offers.slug, slug), eq(offers.active, true)))
      .get()) ?? null
  );
}

export async function getOfferForCourse(courseId: string): Promise<Offer | null> {
  const db = await getDb();
  return (await db.select().from(offers).where(eq(offers.courseId, courseId)).get()) ?? null;
}

export async function getOffersForCourses(courseIds: string[]): Promise<Map<string, Offer>> {
  if (courseIds.length === 0) return new Map();
  const db = await getDb();
  const rows = await db
    .select()
    .from(offers)
    .where(inArray(offers.courseId, courseIds));
  return new Map(
    rows
      .filter((offer): offer is Offer & { courseId: string } => Boolean(offer.courseId))
      .map((offer) => [offer.courseId, offer]),
  );
}

export async function getOfferForBookingType(bookingTypeId: string): Promise<Offer | null> {
  const db = await getDb();
  return (
    (await db.select().from(offers).where(eq(offers.bookingTypeId, bookingTypeId)).get()) ?? null
  );
}

export async function getAllOffers(): Promise<Offer[]> {
  const db = await getDb();
  return db.select().from(offers).orderBy(desc(offers.updatedAt));
}

async function explainExpectedUniqueConflict(
  input: ValidatedOfferInput,
  excludeId?: string,
): Promise<Error | null> {
  const db = await getDb();
  const slugConflict = await db
    .select({ id: offers.id })
    .from(offers)
    .where(
      excludeId
        ? and(eq(offers.slug, input.slug), ne(offers.id, excludeId))
        : eq(offers.slug, input.slug),
    )
    .get();
  if (slugConflict) return new Error(`An offer with slug "${input.slug}" already exists.`);

  if (input.courseId) {
    const conflict = await db
      .select({ id: offers.id })
      .from(offers)
      .where(
        excludeId
          ? and(eq(offers.courseId, input.courseId), ne(offers.id, excludeId))
          : eq(offers.courseId, input.courseId),
      )
      .get();
    if (conflict) return new Error("This course already has a primary offer.");
  }

  if (input.bookingTypeId) {
    const conflict = await db
      .select({ id: offers.id })
      .from(offers)
      .where(
        excludeId
          ? and(eq(offers.bookingTypeId, input.bookingTypeId), ne(offers.id, excludeId))
          : eq(offers.bookingTypeId, input.bookingTypeId),
      )
      .get();
    if (conflict) return new Error("This booking type already has a primary offer.");
  }

  return null;
}

export async function createOffer(input: CreateOfferInput): Promise<Offer> {
  const parsed = createOfferSchema.parse(input);
  const value = normalizeOfferInput(parsed);
  await assertLinkedEntities(value);

  const db = await getDb();
  const expectedConflict = await explainExpectedUniqueConflict(value);
  if (expectedConflict) throw expectedConflict;

  const now = new Date();
  const id = newId("offer");
  try {
    await db.insert(offers).values({
      id,
      ...value,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error: unknown) {
    if (!isUniqueConstraintError(error)) throw error;
    const conflict = await explainExpectedUniqueConflict(value);
    if (conflict) throw conflict;
    throw error;
  }

  const created = await getOfferById(id);
  if (!created) throw new Error("Offer insert committed but could not be re-read.");
  return created;
}

export async function updateOffer(input: UpdateOfferInput): Promise<Offer> {
  const parsed = updateOfferSchema.parse(input);
  const current = await getOfferById(parsed.id);
  if (!current) throw new Error("Offer not found.");

  const merged = normalizeOfferInput({
    kind: parsed.kind ?? current.kind,
    courseId: parsed.courseId === undefined ? current.courseId : parsed.courseId,
    bookingTypeId:
      parsed.bookingTypeId === undefined ? current.bookingTypeId : parsed.bookingTypeId,
    title: parsed.title ?? current.title,
    slug: parsed.slug ?? current.slug,
    accessMode: parsed.accessMode ?? current.accessMode,
    currency: parsed.currency === undefined ? current.currency : parsed.currency,
    amountMinor: parsed.amountMinor === undefined ? current.amountMinor : parsed.amountMinor,
    alternativeCtaLabel:
      parsed.alternativeCtaLabel === undefined
        ? current.alternativeCtaLabel
        : parsed.alternativeCtaLabel,
    alternativeCtaUrl:
      parsed.alternativeCtaUrl === undefined
        ? current.alternativeCtaUrl
        : parsed.alternativeCtaUrl,
    active: parsed.active ?? current.active,
  });
  await assertLinkedEntities(merged);

  const expectedConflict = await explainExpectedUniqueConflict(merged, current.id);
  if (expectedConflict) throw expectedConflict;

  const db = await getDb();
  try {
    await db
      .update(offers)
      .set({
        ...merged,
        updatedAt: new Date(),
      })
      .where(eq(offers.id, current.id));
  } catch (error: unknown) {
    if (!isUniqueConstraintError(error)) throw error;
    const conflict = await explainExpectedUniqueConflict(merged, current.id);
    if (conflict) throw conflict;
    throw error;
  }

  const updated = await getOfferById(current.id);
  if (!updated) throw new Error("Offer update committed but could not be re-read.");
  return updated;
}

export type EffectiveCourseAccessPolicy = {
  source: "OFFER" | "LEGACY_COURSE";
  mode: OfferAccessMode | CourseAccessMode;
  available: boolean;
  offer: Offer | null;
};

/**
 * Mission 08.3 monetization hand-off.
 *
 * Once a course has a linked Offer, the Offer is authoritative for new-access
 * decisions. Existing courses without an Offer keep their Mission 06
 * course.accessMode behavior until they are migrated/configured.
 *
 * An inactive linked Offer does NOT fall back to the legacy course field;
 * deactivating the commercial presentation must fail closed.
 */
export async function getEffectiveCourseAccessPolicy(
  course: Pick<Course, "id" | "accessMode">,
): Promise<EffectiveCourseAccessPolicy> {
  const offer = await getOfferForCourse(course.id);
  if (!offer) {
    return {
      source: "LEGACY_COURSE",
      mode: course.accessMode,
      available: true,
      offer: null,
    };
  }

  return {
    source: "OFFER",
    mode: offer.accessMode,
    available: offer.active,
    offer,
  };
}
