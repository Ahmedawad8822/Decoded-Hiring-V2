import { getDb, courseSections, courses, lessonProgress, lessonResources, lessons } from "@/lib/db";
import { getServerSession } from "@/lib/auth";
import { getCourseResourceObject } from "@/lib/course-resources/service";
import { resolveLessonResourceAccess } from "@/lib/course-resources/access";
import { findSequentialBlocker, lessonReleaseAt } from "@/features/courses/release";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { and, asc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

/**
 * Protected resource download by database ID.
 * Authenticated user AND (admin OR active enrollment in the resource's course
 * with the lesson PUBLISHED). Admin bypasses the published gate so drafts can
 * be retrieved for authoring/review. Private caching semantics — never
 * public/immutable. 404 for unpublished resources to avoid existence leakage.
 * Trashed lessons and trashed courses answer 404 for everyone (restore from
 * the Studio Trash page first) — Trash hides content from every learner view.
 * Authorization verdict lives in lib/course-resources/access.ts (shared with
 * the regression suite; route modules must not export non-HTTP members).
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

  // Resolve the associated lesson (404 when missing — same as unpublished).
  const lesson = await db
    .select()
    .from(lessons)
    .where(eq(lessons.id, resource.lessonId))
    .get();
  // Trash hides content from every learner view: trashed lessons (and
  // resources whose course is trashed) 404 for everyone, admins included.
  const courseRow = await db
    .select({ trashedAt: courses.trashedAt })
    .from(courses)
    .where(eq(courses.id, resource.courseId))
    .get();
  if (!lesson || lesson.trashedAt !== null || !courseRow || courseRow.trashedAt !== null) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  const role = (session.user as { role?: string }).role;
  // The enrollment lookup ONLY happens for non-admins — admins retrieve
  // draft-lesson resources for authoring/review without an enrollment.
  const enrollment =
    role === "admin" ? null : await getEnrollment(session.user.id, resource.courseId);

  // DRIP (Batch J): enrolled learners get a locked verdict (not a 404) while
  // the lesson is unreleased; admins bypass. Section carries the section rule.
  let dripLocked = false;
  let dripReleaseAt: Date | null = null;
  // SEQUENTIAL (learner polish): same locked verdict while earlier required
  // lessons are incomplete; previews bypass. One ordered curriculum read only
  // when the course has `sequential` on.
  let sequentialLocked = false;
  if (lesson && role !== "admin" && hasLearnerAccess(enrollment)) {
    const section = await db
      .select()
      .from(courseSections)
      .where(eq(courseSections.id, lesson.sectionId))
      .get();
    dripReleaseAt = lessonReleaseAt(section ?? null, lesson, enrollment.enrolledAt);
    dripLocked = dripReleaseAt !== null && dripReleaseAt.getTime() > Date.now();
    if (!dripLocked && !lesson.isPreview) {
      const course = await db
        .select({ sequential: courses.sequential })
        .from(courses)
        .where(eq(courses.id, resource.courseId))
        .get();
      if (course?.sequential) {
        const published = await db
          .select()
          .from(lessons)
          .innerJoin(courseSections, eq(lessons.sectionId, courseSections.id))
          .where(and(eq(lessons.courseId, resource.courseId), eq(lessons.status, "published"), isNull(lessons.trashedAt)))
          .orderBy(asc(courseSections.position), asc(lessons.position), asc(lessons.createdAt));
        const ordered = published.map((row) => row.lessons);
        const doneRows = await db
          .select({ lessonId: lessonProgress.lessonId })
          .from(lessonProgress)
          .where(eq(lessonProgress.enrollmentId, enrollment.id));
        sequentialLocked =
          findSequentialBlocker(ordered, new Set(doneRows.map((r) => r.lessonId)), lesson.id) !== null;
      }
    }
  }

  const verdict = resolveLessonResourceAccess({
    role,
    lessonStatus: lesson?.status ?? null,
    enrollment,
    dripLocked,
    dripReleaseAt,
    sequentialLocked,
  });

  if (verdict.status === "not-found") {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }
  if (verdict.status === "forbidden") {
    return NextResponse.json(
      { error: "Forbidden: You are not enrolled in this course" },
      { status: 403 }
    );
  }
  if (verdict.status === "locked") {
    return NextResponse.json(
      sequentialLocked
        ? { error: "Finish the previous lesson to unlock this one." }
        : {
            error: "This lesson has not unlocked yet.",
            ...(verdict.releaseAt ? { releaseAt: verdict.releaseAt.toISOString() } : {}),
          },
      { status: 403 }
    );
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