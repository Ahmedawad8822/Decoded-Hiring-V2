// ============================================================================
// API — KNOWLEDGE UPLOAD
// ----------------------------------------------------------------------------
// Handles multipart/form-data file uploads for the knowledge library.
// Saves the original to private R2 and metadata to D1 with status=UPLOADED.
//
// Security:
//   - requireAdmin() auth check
//   - MIME type whitelist (text/plain, text/markdown)
//   - Content-Length pre-check (reject oversized before buffering)
//   - Server-generated R2 key (never trust client filename)
//   - SHA-256 checksum for duplicate detection
//   - File size limit (2 MB)
// ============================================================================

import { requireAdmin } from "@/lib/auth";
import { httpStatusFor, publicErrorMessage } from "@/lib/errors";
import { uploadKnowledgeSource } from "@/features/editorial-ai/knowledge/storage";
import { isRequestBodyOverLimit } from "@/lib/upload-limits";
import { MAX_KNOWLEDGE_FILE_SIZE, isSupportedMimeType } from "@/features/editorial-ai/knowledge/types";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();

    // Pre-check Content-Length to reject oversized bodies before formData()
    // materializes bytes in memory.
    const contentLength = request.headers.get("content-length");
    const preLimit = MAX_KNOWLEDGE_FILE_SIZE + 2 * 1024; // 2KB form envelope allowance
    if (contentLength && isRequestBodyOverLimit(Number(contentLength), preLimit)) {
      return NextResponse.json(
        { error: `Request body exceeds maximum allowed size (${(preLimit / 1024 / 1024).toFixed(2)} MB).` },
        { status: 413 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: "No valid file provided" }, { status: 400 });
    }

    // Validate MIME type
    const contentType = file.type || "application/octet-stream";
    if (!isSupportedMimeType(contentType)) {
      return NextResponse.json(
        { error: `Unsupported file type "${contentType}". Only text/plain and text/markdown are supported.` },
        { status: 415 }
      );
    }

    // Validate file size
    const byteSize = file.size;
    if (byteSize === 0) {
      return NextResponse.json({ error: "Uploaded file is empty." }, { status: 400 });
    }
    if (byteSize > MAX_KNOWLEDGE_FILE_SIZE) {
      return NextResponse.json(
        { error: `File size exceeds the 2 MB knowledge limit.` },
        { status: 413 }
      );
    }

    // Extract metadata
    const title = formData.get("title")?.toString().trim();
    if (!title || title.length < 3) {
      return NextResponse.json({ error: "Title is required (min 3 characters)." }, { status: 400 });
    }

    const originalFilename = (file as File).name || `upload.txt`;
    const arrayBuffer = await file.arrayBuffer();

    const result = await uploadKnowledgeSource({
      buffer: arrayBuffer,
      filename: originalFilename,
      contentType,
      title,
      author: formData.get("author")?.toString().trim() || null,
      sourceLabel: formData.get("sourceLabel")?.toString().trim() || null,
      notes: formData.get("notes")?.toString().trim() || null,
      createdBy: session.user.id,
    });

    return NextResponse.json(
      {
        id: result.id,
        status: result.status,
        byteSize: result.byteSize,
        checksum: result.checksum,
        mimeType: result.mimeType,
        duplicateOf: result.duplicateOf,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: publicErrorMessage(error, "Upload failed") },
      { status: httpStatusFor(error) }
    );
  }
}
