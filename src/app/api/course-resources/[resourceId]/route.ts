import { getDb, lessonResources, lessons } from "@/lib/db";
import { getServerSession } from "@/lib/auth";
import { getCourseResourceObject } from "@/lib/course-resources/service";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Protected resource download by database ID.
 * Authenticated user AND (admin OR active enrollment in the resource's course).
 * Lesson MUST be published — deny draft/unpublished/archived lesson resources.
 * Private caching semantics — never public/immutable.
 * Returns 404 for unpublished resources to avoid existence leakage.
 */
export async function GET(
  _request: Request,
  props: { params: Promise<{ resourceId: string }> }
) {
  const { resourceId } = await props.params;

  const session = await getServerSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized: You must be signed in" }, { status: 401 });
  }

  const db = await getDb();
  const resource = await db
    .select()
    .from(lessonResources)
    .where(eq(lessonResources.id, resourceId))
    .get();
  if (!resource) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  // Resolve the associated lesson and require it to be PUBLISHED.
  // Non-admin users denied for draft/unpublished/archived lessons.
  // Use 404 to avoid existence leakage of unpublished resources.
  const lesson = await db
    .select()
    .from(lessons)
    .where(eq(lessons.id, resource.lessonId))
    .get();
  if (!lesson || lesson.status !== "published") {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  const role = (session.user as { role?: string }).role;
  if (role !== "admin") {
    const enrollment = await getEnrollment(session.user.id, resource.courseId);
    // SECURITY (review correction C): cancelled enrollments download nothing —
    // same 403 as strangers, so revocation is real on every boundary.
    if (!hasLearnerAccess(enrollment)) {
      return NextResponse.json(
        { error: "Forbidden: You are not enrolled in this course" },
        { status: 403 }
      );
    }
  }

  const object = await getCourseResourceObject(resource.storageKey);
  if (!object) {
    return NextResponse.json({ error: "Resource file not found" }, { status: 404 });
  }

  const safeFilename = resource.filename.replace(/["\r\n]/g, "_");
  return new Response(object.body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": object.contentType,
      "Content-Length": object.size.toString(),
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(object.etag ? { ETag: object.etag } : {}),
    },
  });
}