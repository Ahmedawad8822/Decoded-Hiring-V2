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
}): Promise<UploadMediaResult> {
  const { buffer, filename, contentType, uploadedBy } = params;

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
  const key = `guides/${safeId}.${ext}`;

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
