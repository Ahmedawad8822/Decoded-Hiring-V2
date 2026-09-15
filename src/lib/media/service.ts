import { getR2Bucket } from "../cloudflare/bindings";
import { getDb, media } from "../db";

const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// ============================================================================
// PUBLIC MEDIA NAMESPACE ALLOWLIST (Mission 06 review correction — SECURITY)
// ----------------------------------------------------------------------------
// Protected learner files live under course-resources/<course-id>/<uuid>.pdf
// in the SAME R2 bucket. They must NEVER be served through the public
// /api/media/[...key] route. getMedia() therefore serves ONLY explicitly
// approved public editorial namespaces. Defense in depth: the route returns
// 404 for anything getMedia() rejects, so UUID secrecy is never load-bearing.
// ============================================================================

export const PUBLIC_MEDIA_NAMESPACES = ["guides", "field-notes"] as const;

export type PublicMediaNamespace = (typeof PUBLIC_MEDIA_NAMESPACES)[number];

/** True only for keys inside an approved public namespace (no traversal). */
export function isPublicMediaKey(key: string): boolean {
  const cleanKey = key.replace(/^\/+/, "");
  if (cleanKey.includes("..")) return false;
  const namespace = cleanKey.split("/")[0];
  return (PUBLIC_MEDIA_NAMESPACES as readonly string[]).includes(namespace);
}

export interface UploadMediaResult {
  key: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

export async function uploadMedia(params: {
  buffer: ArrayBuffer | Uint8Array;
  filename: string;
  contentType: string;
  uploadedBy?: string;
  /**
   * Storage namespace prefix (Mission 05: Field Notes reuse the same bucket,
   * endpoint, MIME rules, and size limits — only the key prefix differs).
   * Defaults to "guides" so all existing Guide behavior is unchanged.
   */
  namespace?: "guides" | "field-notes";
}): Promise<UploadMediaResult> {
  const { buffer, filename, contentType, uploadedBy, namespace = "guides" } = params;

  // 1. Validate content type
  const normalizedType = contentType.toLowerCase().trim();
  const ext = ALLOWED_MIME_TYPES[normalizedType];
  if (!ext) {
    throw new Error(
      `Unsupported media type "${contentType}". Supported types: ${Object.keys(ALLOWED_MIME_TYPES).join(", ")}`
    );
  }

  // 2. Validate file size
  const size = buffer.byteLength;
  if (size > MAX_FILE_SIZE) {
    throw new Error(`File size (${(size / 1024 / 1024).toFixed(2)} MB) exceeds maximum limit of 5 MB.`);
  }

  // 3. Generate safe canonical storage key (Never trust client filename as storage path)
  const safeId = crypto.randomUUID();
  const key = `${namespace}/${safeId}.${ext}`;

  // 4. Store in R2 bucket
  const bucket = await getR2Bucket();
  await bucket.put(key, buffer, {
    httpMetadata: {
      contentType: normalizedType,
    },
  });

  // 5. Persist metadata in database
  const db = await getDb();
  await db.insert(media).values({
    id: safeId,
    key,
    filename: filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100),
    contentType: normalizedType,
    size,
    uploadedBy: uploadedBy || null,
    createdAt: new Date(),
  });

  return {
    key,
    url: `/api/media/${key}`,
    filename,
    contentType: normalizedType,
    size,
  };
}

export async function getMedia(key: string) {
  // Prevent path traversal and arbitrary key abuse
  const cleanKey = key.replace(/^\/+/, "");
  if (cleanKey.includes("..") || !/^[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+$/.test(cleanKey)) {
    return null;
  }

  // SECURITY: public media serves ONLY allowlisted editorial namespaces.
  // In particular course-resources/* (protected learner PDFs sharing this
  // bucket) is rejected here, so /api/media answers 404 for it.
  if (!isPublicMediaKey(cleanKey)) {
    return null;
  }

  const bucket = await getR2Bucket();
  const object = await bucket.get(cleanKey);
  if (!object) {
    return null;
  }

  return {
    body: object.body,
    contentType: object.httpMetadata?.contentType || "application/octet-stream",
    size: object.size,
    etag: object.etag,
  };
}
