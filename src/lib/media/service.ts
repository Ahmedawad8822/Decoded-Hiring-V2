import { getR2Bucket } from "../cloudflare/bindings";
import { getDb, media } from "../db";
import { AppError } from "@/lib/errors";

const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  // NOTE (Mission 06 hardening): image/svg+xml is intentionally NOT allowed.
  // SVG is active scriptable content (XSS vector) and must never be accepted
  // as editorial media. Allowed: JPEG, PNG, WebP, AVIF, GIF.
};

/** Editorial media size limit. Exported so routes can reject oversized
 * uploads BEFORE buffering the bytes (service still re-checks byteLength). */
export const MAX_MEDIA_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

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

/**
 * Minimal storage seam for uploadMedia().
 *
 * Production always uses the real R2 bucket / D1 insert (default path).
 * The seam exists ONLY so regression tests can simulate a DB failure
 * after a successful put() without touching the Cloudflare binding
 * architecture.
 */
export interface UploadMediaDeps {
  bucket?: {
    put: (key: string, body: ArrayBuffer | Uint8Array, options?: unknown) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
  };
  /** Persist the media metadata row; defaults to the real D1 insert. */
  record?: (row: {
    id: string;
    key: string;
    filename: string;
    contentType: string;
    size: number;
    uploadedBy: string | null;
    createdAt: Date;
  }) => Promise<void>;
}

export async function uploadMedia(
  params: {
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
  },
  deps?: UploadMediaDeps
): Promise<UploadMediaResult> {
  const { buffer, filename, contentType, uploadedBy, namespace = "guides" } = params;

  // 1. Validate content type
  const normalizedType = contentType.toLowerCase().trim();
  const ext = ALLOWED_MIME_TYPES[normalizedType];
  if (!ext) {
    throw new AppError("invalid",
      `Unsupported media type "${contentType}". Supported types: ${Object.keys(ALLOWED_MIME_TYPES).join(", ")}`
    );
  }

  // 2. Validate file size (defense in depth — routes already gate pre-buffer)
  const size = buffer.byteLength;
  if (size > MAX_MEDIA_FILE_SIZE) {
    throw new AppError("invalid", `File size (${(size / 1024 / 1024).toFixed(2)} MB) exceeds maximum limit of 5 MB.`);
  }

  // 3. Generate safe canonical storage key (Never trust client filename as storage path)
  const safeId = crypto.randomUUID();
  const key = `${namespace}/${safeId}.${ext}`;

  // 4. Store in R2 bucket (object is written BEFORE DB metadata)
  const bucket = deps?.bucket ?? (await getR2Bucket());
  await bucket.put(key, buffer, {
    httpMetadata: {
      contentType: normalizedType,
    },
  });

  // 5. Persist metadata in database. If the insert fails AFTER a successful
  // put(), best-effort delete the orphaned R2 object before rethrowing the
  // ORIGINAL error. A cleanup failure must never mask the DB failure.
  const record =
    deps?.record ??
    (async (row: {
      id: string;
      key: string;
      filename: string;
      contentType: string;
      size: number;
      uploadedBy: string | null;
      createdAt: Date;
    }) => {
      const db = await getDb();
      await db.insert(media).values(row);
    });
  const row = {
    id: safeId,
    key,
    filename: filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100),
    contentType: normalizedType,
    size,
    uploadedBy: uploadedBy || null,
    createdAt: new Date(),
  };
  try {
    await record(row);
  } catch (dbError) {
    try {
      await bucket.delete(key);
    } catch {
      // Intentionally swallowed: the original DB failure below is the error
      // the caller must see. Cleanup is best-effort only.
    }
    throw dbError;
  }

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
