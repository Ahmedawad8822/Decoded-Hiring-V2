import { getDb, guides, Guide } from "@/lib/db";
import { and, desc, eq, ne } from "drizzle-orm";
import { CreateGuideInput, UpdateGuideInput } from "./types";
import { resolvePreviewAccess } from "@/features/publishing/preview";
import {
  buildArchiveUpdate,
  buildEditTouch,
  buildPublishUpdate,
  buildUnpublishUpdate,
  assertGuideTransition,
} from "@/features/publishing/lifecycle";
import { isUniqueConstraintError } from "@/lib/db/sqlite-errors";

export async function getPublishedGuides(): Promise<Guide[]> {
  const db = await getDb();
  return db
    .select()
    .from(guides)
    .where(eq(guides.status, "published"))
    .orderBy(desc(guides.publishedAt), desc(guides.updatedAt));
}

export async function getPublicGuideBySlug(
  slug: string,
  options?: { preview?: boolean; session?: { user?: { id?: string; role?: string | null } } | null }
): Promise<Guide | null> {
  const db = await getDb();
  const guide = await db.select().from(guides).where(eq(guides.slug, slug)).get();

  if (!guide) {
    return null;
  }

  // 1. Published guides are always visible
  if (guide.status === "published") {
    return guide;
  }

  // 2. Draft / Archived guides are only visible if preview is requested AND requester is an authenticated admin
  if (resolvePreviewAccess({ preview: options?.preview, session: options?.session })) {
    return guide;
  }

  // 3. Otherwise, return null (404 behavior per Correction 10 & 11)
  return null;
}

export async function getAllAdminGuides(): Promise<Guide[]> {
  const db = await getDb();
  return db.select().from(guides).orderBy(desc(guides.updatedAt));
}

export async function getAdminGuideById(id: string): Promise<Guide | null> {
  const db = await getDb();
  const guide = await db.select().from(guides).where(eq(guides.id, id)).get();
  return guide || null;
}

export async function createGuide(input: CreateGuideInput): Promise<Guide> {
  const db = await getDb();

  // Enforce slug uniqueness at domain level
  const existing = await db.select().from(guides).where(eq(guides.slug, input.slug)).get();
  if (existing) {
    throw new Error(`A guide with the slug "${input.slug}" already exists. Please choose a unique slug.`);
  }

  const now = new Date();
  const id = `guide_${crypto.randomUUID().slice(0, 12)}`;

  try {
    await db.insert(guides).values({
      id,
      title: input.title,
      slug: input.slug,
      excerpt: input.excerpt || null,
      body: JSON.stringify(input.body || []),
      coverImage: input.coverImage || null,
      author: input.author || "Decoded Editorial",
      category: input.category || null,
      tags: input.tags || null,
      status: "draft",
      metaTitle: input.metaTitle || input.title,
      metaDescription: input.metaDescription || input.excerpt || null,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    });
  } catch (error: unknown) {
    // The guides.slug UNIQUE index is the authoritative concurrency
    // backstop: the pre-check above cannot see a parallel insert. Only that
    // condition is converted to the same domain error the pre-check raises;
    // anything else propagates untouched.
    if (!isUniqueConstraintError(error)) throw error;
    // Verify the EXPECTED business-key conflict exists (a guide with this
    // slug) before converting; otherwise rethrow the original DB error.
    const conflict = await db.select().from(guides).where(eq(guides.slug, input.slug)).get();
    if (!conflict) throw error;
    throw new Error(`A guide with the slug "${input.slug}" already exists. Please choose a unique slug.`);
  }

  const created = await getAdminGuideById(id);
  if (!created) {
    throw new Error("Failed to retrieve created guide");
  }
  return created;
}

export async function updateGuide(id: string, input: UpdateGuideInput): Promise<Guide> {
  const db = await getDb();
  const current = await getAdminGuideById(id);
  if (!current) {
    throw new Error(`Guide with id "${id}" not found`);
  }

  // Check slug uniqueness if slug is being modified
  if (input.slug && input.slug !== current.slug) {
    const existing = await db
      .select()
      .from(guides)
      .where(and(eq(guides.slug, input.slug), ne(guides.id, id)))
      .get();
    if (existing) {
      throw new Error(`A guide with the slug "${input.slug}" already exists.`);
    }
  }

  const now = new Date();
  const updateData: Partial<typeof guides.$inferInsert> = {
    ...buildEditTouch(now),
  };

  if (typeof input.title !== "undefined") updateData.title = input.title;
  if (typeof input.slug !== "undefined") updateData.slug = input.slug;
  if (typeof input.excerpt !== "undefined") updateData.excerpt = input.excerpt;
  if (typeof input.body !== "undefined") updateData.body = JSON.stringify(input.body);
  if (typeof input.coverImage !== "undefined") updateData.coverImage = input.coverImage;
  if (typeof input.author !== "undefined") updateData.author = input.author;
  if (typeof input.category !== "undefined") updateData.category = input.category;
  if (typeof input.tags !== "undefined") updateData.tags = input.tags;
  if (typeof input.metaTitle !== "undefined") updateData.metaTitle = input.metaTitle;
  if (typeof input.metaDescription !== "undefined") updateData.metaDescription = input.metaDescription;

  try {
    await db.update(guides).set(updateData).where(eq(guides.id, id));
  } catch (error: unknown) {
    // Same race rule as create: only a lost slug-unique race converts to the
    // friendly domain error; unrelated DB errors propagate untouched.
    if (!isUniqueConstraintError(error)) throw error;
    // Verify the EXPECTED business-key conflict exists (a DIFFERENT guide
    // with this slug) before converting; otherwise rethrow the original.
    const conflict = await db
      .select()
      .from(guides)
      .where(and(eq(guides.slug, updateData.slug ?? input.slug ?? current.slug), ne(guides.id, id)))
      .get();
    if (!conflict) throw error;
    throw new Error(`A guide with the slug "${input.slug}" already exists.`);
  }

  const updated = await getAdminGuideById(id);
  if (!updated) {
    throw new Error("Failed to retrieve updated guide");
  }
  return updated;
}

export async function publishGuide(id: string): Promise<Guide> {
  const db = await getDb();
  const current = await getAdminGuideById(id);
  if (!current) {
    throw new Error(`Guide with id "${id}" not found`);
  }

  assertGuideTransition(current.status, "publish");

  const now = new Date();
  await db
    .update(guides)
    .set(buildPublishUpdate({ publishedAt: current.publishedAt }, now))
    .where(eq(guides.id, id));

  return (await getAdminGuideById(id))!;
}

export async function unpublishGuide(id: string): Promise<Guide> {
  const db = await getDb();
  const current = await getAdminGuideById(id);
  if (!current) {
    throw new Error(`Guide with id "${id}" not found`);
  }

  assertGuideTransition(current.status, "unpublish");

  const now = new Date();
  await db
    .update(guides)
    .set(buildUnpublishUpdate(now))
    .where(eq(guides.id, id));

  return (await getAdminGuideById(id))!;
}

export async function archiveGuide(id: string): Promise<Guide> {
  const db = await getDb();
  const current = await getAdminGuideById(id);
  if (!current) {
    throw new Error(`Guide with id "${id}" not found`);
  }

  assertGuideTransition(current.status, "archive");

  const now = new Date();
  await db
    .update(guides)
    .set(buildArchiveUpdate(now))
    .where(eq(guides.id, id));

  return (await getAdminGuideById(id))!;
}
