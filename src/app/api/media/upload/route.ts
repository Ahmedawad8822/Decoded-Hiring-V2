import { requireAdmin } from "@/lib/auth";
import { uploadMedia } from "@/lib/media/service";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();

    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: "No valid file provided" }, { status: 400 });
    }

    const filename = (file as File).name || "upload";
    const contentType = file.type || "application/octet-stream";
    const arrayBuffer = await file.arrayBuffer();

    const result = await uploadMedia({
      buffer: arrayBuffer,
      filename,
      contentType,
      uploadedBy: session.user.id,
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
