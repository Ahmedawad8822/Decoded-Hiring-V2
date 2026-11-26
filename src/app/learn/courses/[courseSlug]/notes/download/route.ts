import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { getLearnerCourseBySlug } from "@/features/courses/service";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { listMyCourseNotes } from "@/features/notes/service";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function safeFilename(slug: string): string {
  const cleaned = slug.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return cleaned || "course";
}

/**
 * Owner-only plain-text export. Same enrolled access as the notes page; never
 * cached or shared. Content is lesson titles plus note bodies, nothing else.
 */
export async function GET(
  request: Request,
  props: { params: Promise<{ courseSlug: string }> },
) {
  const { courseSlug } = await props.params;
  const session = await getServerSession();
  if (!session?.user) {
    const target = new URL(
      `/login?redirect=${encodeURIComponent(`/learn/courses/${courseSlug}/notes`)}`,
      request.url,
    );
    const response = NextResponse.redirect(target);
    response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return response;
  }

  const course = await getLearnerCourseBySlug(courseSlug, session.user.id);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404, headers: NO_STORE });
  }

  const enrollment = await getEnrollment(session.user.id, course.id);
  if (!hasLearnerAccess(enrollment)) {
    return NextResponse.json({ error: "Course not found" }, { status: 404, headers: NO_STORE });
  }

  const notes = await listMyCourseNotes(session.user.id, course.id, { enrolledAt: enrollment.enrolledAt });
  const header = `${course.title} — My notes`;
  const text =
    notes.length === 0
      ? `${header}\n\nNo notes yet.\n`
      : `${header}\n\n${notes
          .map((note) => `${note.lessonTitle}\n\n${note.body}`)
          .join("\n\n")}\n`;

  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename(course.slug)}-notes.txt"`,
      "X-Content-Type-Options": "nosniff",
      ...NO_STORE,
    },
  });
}
