import Link from "next/link";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { getLearnerCourseBySlug } from "@/features/courses/service";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { resolveCourseRedirect } from "@/features/slug-redirects/service";
import { listMyCourseNotes } from "@/features/notes/service";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "My notes | Decoded Hiring",
  robots: { index: false, follow: false },
};

const updatedFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export default async function CourseNotesPage(props: {
  params: Promise<{ courseSlug: string }>;
}) {
  const { courseSlug } = await props.params;
  const session = await getServerSession();
  if (!session?.user) {
    redirect(`/login?redirect=${encodeURIComponent(`/learn/courses/${courseSlug}/notes`)}`);
  }

  const course = await getLearnerCourseBySlug(courseSlug, session.user.id);
  if (!course) {
    const target = await resolveCourseRedirect(courseSlug);
    if (target) permanentRedirect(`${target}/notes`);
    notFound();
  }

  const enrollment = await getEnrollment(session.user.id, course.id);
  if (!hasLearnerAccess(enrollment)) notFound();

  const notes = await listMyCourseNotes(session.user.id, course.id, { enrolledAt: enrollment.enrolledAt });
  const courseHref = `/learn/courses/${course.slug}`;

  return (
    <main className="sec-app learner-page" id="main">
      <div className="wrap learner-column">
        <p className="a-micro learner-mb-6">
          <Link className="learner-inherit" href={courseHref}>
            {course.title.toUpperCase()}
          </Link>{" "}
          · MY NOTES
        </p>
        <div className="notes-page-head">
          <div>
            <h1 className="a-h1">My notes</h1>
            <p className="muted learner-mt-12">
              Private to you. Only you can see these notes.
            </p>
          </div>
          {notes.length > 0 && (
            <a
              className="btn secondary learner-link"
              href={`${courseHref}/notes/download`}
              download
            >
              Download as text
            </a>
          )}
        </div>

        {notes.length === 0 ? (
          <section className="learner-empty learner-mt-36" aria-labelledby="notes-empty-h">
            <h2 className="a-h2 learner-empty-title" id="notes-empty-h">
              No notes yet
            </h2>
            <p className="learner-empty-intro">
              Open any lesson and add a note. Your notes stay private and are listed here in
              curriculum order.
            </p>
            <div className="learner-mt-16">
              <Link className="btn primary learner-link" href={courseHref}>
                Back to course →
              </Link>
            </div>
          </section>
        ) : (
          <div className="notes-list learner-mt-36">
            {notes.map((note) => (
              <article className="note-entry" key={note.id}>
                <div className="note-entry-head">
                  <h2 className="note-entry-title">
                    <Link href={`${courseHref}/lessons/${note.lessonSlug}`}>
                      {note.lessonTitle}
                    </Link>
                  </h2>
                  <p className="note-entry-time mono">
                    <time dateTime={note.updatedAt.toISOString()}>
                      {updatedFormatter.format(note.updatedAt)}
                    </time>
                  </p>
                </div>
                <div className="note-entry-body">{note.body}</div>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
