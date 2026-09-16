import { requireAdmin } from "@/lib/auth";
import { MAX_COURSE_RESOURCE_SIZE, uploadCourseResource } from "@/lib/course-resources/service";
import { isRequestBodyOverLimit } from "@/lib/upload-limits";
import { getAdminCourseById, getAdminLessonById } from "@/features/courses/service";
import { NextResponse } from "next/server";

/** Admin-only PDF upload for a lesson. Never trust client keys — minted server-side. */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin();

    // Early Content-Length check (Item K: upload size defense — layer 1)
    // Reject oversized bodies before formData() materializes bytes in memory.
    // The guard permits a small, explicit multipart/form envelope allowance so
    // a valid file AT the 10 MB limit with its envelope is not false-rejected;
    // the exact FILE limit is enforced by File.size and the service below.
    const contentLength = request.headers.get("content-length");
    if (contentLength && isRequestBodyOverLimit(Number(contentLength), MAX_COURSE_RESOURCE_SIZE)) {
      return NextResponse.json(
        { error: `Request body exceeds maximum limit of 10 MB.` },
        { status: 413 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const courseId = formData.get("courseId");
    const lessonId = formData.get("lessonId");
    const rawTitle = formData.get("title");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: "No valid file provided" }, { status: 400 });
    }
    if (typeof courseId !== "string" || !courseId) {
      return NextResponse.json({ error: "courseId is required" }, { status: 400 });
    }
    if (typeof lessonId !== "string" || !lessonId) {
      return NextResponse.json({ error: "lessonId is required" }, { status: 400 });
    }

    // Resolve ownership server-side: lesson must belong to the course.
    const course = await getAdminCourseById(courseId);
    if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });
    const lesson = await getAdminLessonById(lessonId);
    if (!lesson || lesson.courseId !== courseId) {
      return NextResponse.json({ error: "Lesson does not belong to this course" }, { status: 400 });
    }

    const filename = (file as File).name || "resource.pdf";
    const contentType = file.type || "application/octet-stream";
    // PERFORMANCE/SECURITY (review correction I): reject oversized uploads
    // BEFORE file.arrayBuffer() materializes the bytes in memory — a hostile
    // multi-GB body must never be buffered server-side.
    const declaredSize = typeof (file as File).size === "number" ? (file as File).size : NaN;
    if (Number.isFinite(declaredSize) && declaredSize > MAX_COURSE_RESOURCE_SIZE) {
      return NextResponse.json(
        {
          error: `File size (${(declaredSize / 1024 / 1024).toFixed(2)} MB) exceeds the 10 MB course-resource limit.`,
        },
        { status: 413 }
      );
    }
    const arrayBuffer = await file.arrayBuffer();

    const result = await uploadCourseResource({
      buffer: arrayBuffer,
      filename,
      contentType,
      courseId,
      lessonId,
      title: typeof rawTitle === "string" ? rawTitle : filename,
    });

    void session;
    return NextResponse.json(result, { status: 201 });
  } catch (error: unknown) {
    const err = error as Error;
    if (err.message?.includes("Unauthorized") || err.message?.includes("Forbidden")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json({ error: err.message || "Upload failed" }, { status: 400 });
  }
}
