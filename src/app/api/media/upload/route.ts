import { requireAdmin } from "@/lib/auth";
import { MAX_MEDIA_FILE_SIZE, uploadMedia } from "@/lib/media/service";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();

    // Early Content-Length check (Item K: upload size defense)
    // Reject oversized bodies before formData() materializes bytes in memory.
    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_MEDIA_FILE_SIZE) {
      return NextResponse.json(
        { error: `Request body exceeds maximum limit of 5 MB.` },
        { status: 413 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: "No valid file provided" }, { status: 400 });
    }

    const filename = (file as File).name || "upload";
    const contentType = file.type || "application/octet-stream";
    // SECURITY/PERFORMANCE (Mission 06): reject oversized uploads BEFORE
    // file.arrayBuffer() materializes the bytes in memory — the same
    // pre-buffer gate course-resource uploads already apply. A hostile
    // multi-GB body must never be buffered server-side. The service-level
    // byteLength check remains as defense in depth for callers that bypass
    // this route.
    const declaredSize = typeof (file as File).size === "number" ? (file as File).size : NaN;
    if (Number.isFinite(declaredSize) && declaredSize > MAX_MEDIA_FILE_SIZE) {
      return NextResponse.json(
        {
          error: `File size (${(declaredSize / 1024 / 1024).toFixed(2)} MB) exceeds maximum limit of 5 MB.`,
        },
        { status: 413 }
      );
    }
    const arrayBuffer = await file.arrayBuffer();

    // Mission 05: Field Notes reuse the same endpoint/bucket/rules — only
    // the storage key prefix differs. Defaults to "guides" (unchanged).
    const rawNamespace = formData.get("namespace");
    const namespace = rawNamespace === "field-notes" ? "field-notes" : "guides";

    const result = await uploadMedia({
      buffer: arrayBuffer,
      filename,
      contentType,
      uploadedBy: session.user.id,
      namespace,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error: unknown) {
    const err = error as Error;
    if (err.message?.includes("Unauthorized") || err.message?.includes("Forbidden")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json(
      { error: err.message || "Upload failed" },
      { status: 400 }
    );
  }
}
