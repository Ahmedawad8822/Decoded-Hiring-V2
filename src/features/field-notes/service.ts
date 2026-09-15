import { getDb, fieldNotes, fieldNoteRevisions, FieldNote, FieldNoteRevision } from "@/lib/db";
import { and, desc, eq, ne } from "drizzle-orm";
import { CreateFieldNoteInput, UpdateFieldNoteInput } from "./types";
import { resolvePreviewAccess } from "@/features/publishing/preview";
import {
  buildArchiveUpdate,
  buildEditTouch,
  buildPublishUpdate,
  buildUnpublishUpdate,
} from "@/features/publishing/lifecycle";
import type { FieldNoteRevisionTrigger } from "@/lib/db";

// ============================================================================
// FIELD NOTE SERVICE (Mission 05)
// ----------------------------------------------------------------------------
// Explicit per-domain data access (no generic repositories). Lifecycle and
// preview rules come from the shared publishing primitives; Guide security
// semantics are mirrored: drafts/archived notes are invisible publicly,
// admin preview requires ?preview=true + admin session.
// Revision history: a snapshot is recorded on publish and on every update
// applied while published, plus unpublish/archive transitions — so the
// history always shows what actually went live and what changed it.
// ============================================================================

export async function getPublishedFieldNotes(): Promise<FieldNote[]> {
  const db = await getDb();
  return db
    .select()
    .from(fieldNotes)
    .where(eq(fieldNotes.status, "published"))
    .orderBy(desc(fieldNotes.publishedAt), desc(fieldNotes.updatedAt));
}

export async function getPublicFieldNoteBySlug(
  slug: string,
  options?: { preview?: boolean; session?: { user?: { id?: string; role?: string | null } } | null }
): Promise<FieldNote | null> {
  const db = await getDb();
  const note = await db.select().from(fieldNotes).where(eq(fieldNotes.slug, slug)).get();

  if (!note) {
    return null;
  }

  // 1. Published notes are always visible
  if (note.status === "published") {
    return note;
  }

  // 2. Draft / Archived notes only with preview + authenticated admin
  if (resolvePreviewAccess({ preview: options?.preview, session: options?.session })) {
    return note;
  }

  // 3. Otherwise 404
  return null;
}

export async function getAllAdminFieldNotes(): Promise<FieldNote[]> {
  const db = await getDb();
  return db.select().from(fieldNotes).orderBy(desc(fieldNotes.updatedAt));
}

export async function getAdminFieldNoteById(id: string): Promise<FieldNote | null> {
  const db = await getDb();
  const note = await db.select().from(fieldNotes).where(eq(fieldNotes.id, id)).get();
  return note || null;
}

export async function getFieldNoteRevisions(fieldNoteId: string): Promise<FieldNoteRevision[]> {
  const db = await getDb();
  return db
    .select()
    .from(fieldNoteRevisions)
    .where(eq(fieldNoteRevisions.fieldNoteId, fieldNoteId))
    .orderBy(desc(fieldNoteRevisions.createdAt));
}

async function recordRevision(
  note: FieldNote,
  trigger: FieldNoteRevisionTrigger,
  createdBy?: string | null
): Promise<void> {
  const db = await getDb();
  await db.insert(fieldNoteRevisions).values({
    id: `fnrev_${crypto.randomUUID().slice(0, 12)}`,
    fieldNoteId: note.id,
    title: note.title,
    body: note.body,
    status: note.status,
    trigger,
    createdBy: createdBy || null,
    createdAt: new Date(),
  });
}

export async function createFieldNote(input: CreateFieldNoteInput): Promise<FieldNote> {
  const db = await getDb();

  // Enforce slug uniqueness at domain level
  const existing = await db.select().from(fieldNotes).where(eq(fieldNotes.slug, input.slug)).get();
  if (existing) {
    throw new Error(`A field note with the slug "${input.slug}" already exists. Please choose a unique slug.`);
  }

  const now = new Date();
  const id = `fn_${crypto.randomUUID().slice(0, 12)}`;

  await db.insert(fieldNotes).values({
    id,
    title: input.title,
    slug: input.slug,
    excerpt: input.excerpt || null,
    body: JSON.stringify(input.body || []),
    coverImage: input.coverImage || null,
    author: input.author || "Ahmed Awad",
    status: "draft",
    metaTitle: input.metaTitle || input.title,
    metaDescription: input.metaDescription || input.excerpt || null,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
  });

  const created = await getAdminFieldNoteById(id);
  if (!created) {
    throw new Error("Failed to retrieve created field note");
  }
  return created;
}

export async function updateFieldNote(
  id: string,
  input: UpdateFieldNoteInput,
  options?: { createdBy?: string | null }
): Promise<FieldNote> {
  const db = await getDb();
  const current = await getAdminFieldNoteById(id);
  if (!current) {
    throw new Error(`Field note with id "${id}" not found`);
  }

  // Check slug uniqueness if slug is being modified
  if (input.slug && input.slug !== current.slug) {
    const existing = await db
      .select()
      .from(fieldNotes)
      .where(and(eq(fieldNotes.slug, input.slug), ne(fieldNotes.id, id)))
      .get();
    if (existing) {
      throw new Error(`A field note with the slug "${input.slug}" already exists.`);
    }
  }

  const now = new Date();
  const updateData: Partial<typeof fieldNotes.$inferInsert> = {
    ...buildEditTouch(now),
  };

  if (typeof input.title !== "undefined") updateData.title = input.title;
  if (typeof input.slug !== "undefined") updateData.slug = input.slug;
  if (typeof input.excerpt !== "undefined") updateData.excerpt = input.excerpt;
  if (typeof input.body !== "undefined") updateData.body = JSON.stringify(input.body);
  if (typeof input.coverImage !== "undefined") updateData.coverImage = input.coverImage;
  if (typeof input.author !== "undefined") updateData.author = input.author;
  if (typeof input.metaTitle !== "undefined") updateData.metaTitle = input.metaTitle;
  if (typeof input.metaDescription !== "undefined") updateData.metaDescription = input.metaDescription;

  await db.update(fieldNotes).set(updateData).where(eq(fieldNotes.id, id));

  const updated = await getAdminFieldNoteById(id);
  if (!updated) {
    throw new Error("Failed to retrieve updated field note");
  }

  // Preserve edit history for published content
  if (current.status === "published") {
    await recordRevision(updated, "update", options?.createdBy);
  }

  return updated;
}

export async function publishFieldNote(
  id: string,
  options?: { createdBy?: string | null }
): Promise<FieldNote> {
  const db = await getDb();
  const current = await getAdminFieldNoteById(id);
  if (!current) {
    throw new Error(`Field note with id "${id}" not found`);
  }

  const now = new Date();
  await db
    .update(fieldNotes)
    .set(buildPublishUpdate({ publishedAt: current.publishedAt }, now))
    .where(eq(fieldNotes.id, id));

  const published = (await getAdminFieldNoteById(id))!;
  await recordRevision(published, "publish", options?.createdBy);
  return published;
}

export async function unpublishFieldNote(
  id: string,
  options?: { createdBy?: string | null }
): Promise<FieldNote> {
  const db = await getDb();
  const current = await getAdminFieldNoteById(id);
  if (!current) {
    throw new Error(`Field note with id "${id}" not found`);
  }

  const now = new Date();
  await db
    .update(fieldNotes)
    .set(buildUnpublishUpdate(now))
    .where(eq(fieldNotes.id, id));

  const draft = (await getAdminFieldNoteById(id))!;
  await recordRevision(draft, "unpublish", options?.createdBy);
  return draft;
}

export async function archiveFieldNote(
  id: string,
  options?: { createdBy?: string | null }
): Promise<FieldNote> {
  const db = await getDb();
  const current = await getAdminFieldNoteById(id);
  if (!current) {
    throw new Error(`Field note with id "${id}" not found`);
  }

  const now = new Date();
  await db
    .update(fieldNotes)
    .set(buildArchiveUpdate(now))
    .where(eq(fieldNotes.id, id));

  const archived = (await getAdminFieldNoteById(id))!;
  await recordRevision(archived, "archive", options?.createdBy);
  return archived;
}
