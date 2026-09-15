import { getR2Bucket } from "../cloudflare/bindings";
import { getDb, lessonResources } from "../db";
import { eq } from "drizzle-orm";

// ============================================================================
// PRIVATE COURSE RESOURCES (Mission 06 security boundary)
// ----------------------------------------------------------------------------
// Protected learner files live under course-resources/<course-id>/<uuid>.pdf
// in the SAME R2 bucket but a DIFFERENT namespace from public editorial
// media (guides/, field-notes/). They are NEVER served through the public
// /api/media/[...key] route — only by ID through
// /api/course-resources/[resourceId], which enforces:
//   authenticated user AND (admin OR active enrollment in the course).
// Responses carry private caching semantics (never public, immutable).
// MIME scope: PDF only. Size limit: 10 MB.
// ============================================================================

const ALLOWED_COURSE_RESOURCE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
};

const MAX_RESOURCE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Shared size cap so the upload route can reject BEFORE file.arrayBuffer(). */
export const MAX_COURSE_RESOURCE_SIZE = MAX_RESOURCE_SIZE;

/** First bytes every valid PDF starts with ("%PDF-"). Checked before storage. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // % P D F -

/** True only when the leading bytes are the PDF magic header. */
export function hasPdfMagicBytes(buffer: ArrayBuffer | Uint8Array): boolean {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

export interface CourseResourceUploadResult {
  id: string;
  storageKey: string;
  filename: string;
  contentType: string;
  size: number;
}

export async function uploadCourseResource(params: {
  buffer: ArrayBuffer | Uint8Array;
  filename: string;
  contentType: string;
  courseId: string;
  lessonId: string;
  title: string;
}): Promise<CourseResourceUploadResult> {
  const { buffer, filename, contentType, courseId, lessonId, title } = params;

  const normalizedType = contentType.toLowerCase().trim();
  const ext = ALLOWED_COURSE_RESOURCE_TYPES[normalizedType];
  if (!ext) {
    throw new Error(
      `Unsupported resource type "${contentType}". Mission 06 supports PDF only (application/pdf).`
    );
  }

  const size = buffer.byteLength;
  if (size === 0) throw new Error("Uploaded file is empty.");
  if (size > MAX_RESOURCE_SIZE) {
    throw new Error(
      `File size (${(size / 1024 / 1024).toFixed(2)} MB) exceeds the 10 MB course-resource limit.`
    );
  }
  // RELIABILITY (review correction J): MIME headers are client-controlled —
  // verify the PDF magic bytes (%PDF-) so a renamed executable can't be
  // stored as a trusted "PDF" download.
  if (!hasPdfMagicBytes(buffer)) {
    throw new Error("Uploaded file is not a valid PDF (missing %PDF- header).");
  }

  const safeCourseId = courseId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const resourceId = `res_${crypto.randomUUID().slice(0, 12)}`;
  const storageKey = `course-resources/${safeCourseId}/${crypto.randomUUID()}.${ext}`;

  const bucket = await getR2Bucket();
  await bucket.put(storageKey, buffer, {
    httpMetadata: { contentType: normalizedType },
  });

  const db = await getDb();
  const existing = await db
    .select()
    .from(lessonResources)
    .where(eq(lessonResources.lessonId, lessonId));
  const position = existing.length;

  // RELIABILITY (review correction K): the R2 object is orphaned if the DB
  // metadata insert fails — delete it before surfacing the error so storage
  // and the lesson_resources table can never disagree.
  try {
    await db.insert(lessonResources).values({
      id: resourceId,
      courseId,
      lessonId,
      title: title.trim().slice(0, 160) || filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100),
      storageKey,
      filename: filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100),
      contentType: normalizedType,
      size,
      position,
      createdAt: new Date(),
    });
  } catch (err) {
    await bucket.delete(storageKey).catch(() => undefined);
    throw err;
  }

  return { id: resourceId, storageKey, filename, contentType: normalizedType, size };
}

export async function getCourseResourceObject(storageKey: string) {
  // Strict namespace check — only keys WE minted under course-resources/.
  if (
    !storageKey.startsWith("course-resources/") ||
    storageKey.includes("..") ||
    !/^[a-zA-Z0-9_\-/.]+$/.test(storageKey)
  ) {
    return null;
  }
  const bucket = await getR2Bucket();
  const object = await bucket.get(storageKey);
  if (!object) return null;
  return {
    body: object.body,
    contentType: object.httpMetadata?.contentType || "application/pdf",
    size: object.size,
    etag: object.etag,
  };
}
