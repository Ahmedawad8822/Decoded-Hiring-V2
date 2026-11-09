import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { resolveLessonRedirect } from "@/features/slug-redirects/service";
import { getServerSession } from "@/lib/auth";
import {
  getCourseCurriculum,
  getLearnerCourseBySlug,
  getPublishedCourseBySlug,
  getPublishedLessonBySlug,
  parseLessonBody,
} from "@/features/courses/service";
import { getEnrollment } from "@/features/enrollments/service";
import { hasLearnerAccess } from "@/features/enrollments/access";
import { getEnrollmentProgress, getLessonContinuationHref } from "@/features/progress/service";
import { getLessonResources } from "@/features/courses/service";
import { ContentBlockRenderer } from "@/components/publishing/ContentBlockRenderer";
import { buildYouTubeEmbedUrl } from "@/features/courses/youtube";
import { CompleteButton } from "@/components/learner/complete-button";
import { LessonPlayerShell } from "@/components/learner/lesson-player-shell";

export async function generateMetadata(props: {
  params: Promise<{ courseSlug: string; lessonSlug: string }>;
}) {
  const { courseSlug, lessonSlug } = await props.params;
  const course = await getPublishedCourseBySlug(courseSlug);
  const lesson = course ? await getPublishedLessonBySlug(course.id, lessonSlug) : null;
  return {
    title: lesson && course ? `${lesson.title} · ${course.title} | Decoded Hiring` : "Lesson | Decoded Hiring",
  };
}

export default async function LessonPlayerPage(props: {
  params: Promise<{ courseSlug: string; lessonSlug: string }>;
}) {
  const { courseSlug, lessonSlug } = await props.params;
  // Archived courses stay visible to already-entitled learners (correction D);
  // everyone else 404s here exactly as before.
  const session = await getServerSession();
  const course = await getLearnerCourseBySlug(courseSlug, session?.user?.id);
  // Stale course and/or lesson slug: one permanent redirect to the current URL.
  const lesson = course ? await getPublishedLessonBySlug(course.id, lessonSlug) : null;
  if (!course || !lesson) {
    const target = await resolveLessonRedirect(courseSlug, lessonSlug);
    if (target) permanentRedirect(target);
    notFound();
  }

  // Server-side enrollment gate: no (or cancelled) enrollment → denied panel
  // (never the body). Cancelled learners re-enroll from the course page.
  const enrollment = session?.user ? await getEnrollment(session.user.id, course.id) : null;
  if (!hasLearnerAccess(enrollment)) {
    return (
      <main className="sec-app learner-page" id="main">
        <div className="wrap learner-column">
          <p className="a-micro learner-mb-6">
            <Link className="learner-inherit" href={`/learn/courses/${course.slug}`}>
              {course.title.toUpperCase()}
            </Link>
          </p>
          <h1 className="a-h1">Enrollment required</h1>
          <p className="muted-strong learner-intro">
            “{lesson.title}” is part of {course.title}. Enroll to unlock the lesson content,
            videos, and downloadable resources.
          </p>
          <div className="learner-mt-16">
            <Link className="btn primary learner-link" href={`/learn/courses/${course.slug}`}>
              Go to course →
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const curriculum = await getCourseCurriculum(course.id);
  const progress = await getEnrollmentProgress(enrollment);
  const completedSet = new Set(progress.completedLessonIds);
  const resources = await getLessonResources(lesson.id);
  const blocks = parseLessonBody(lesson);
  const embedUrl = lesson.videoUrl ? buildYouTubeEmbedUrl(lesson.videoUrl) : null;

  const flat = curriculum.flatMap((c) => c.publishedLessons);
  const idx = flat.findIndex((l) => l.id === lesson.id);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;

  const continueHref = getLessonContinuationHref(course, lesson.id, flat, progress.completedLessonIds);
  const finishHref = progress.completed ? `/learn/courses/${course.slug}/complete` : `/learn/courses/${course.slug}`;

  const positionLabel = `LESSON ${idx + 1} OF ${flat.length}`;

  const curriculumNav = (
    <nav className="curriculum" aria-label="Curriculum">
      <div className="cu-head">
        <p className="t">{course.title}</p>
        <p className="s mono">
          {progress.completedRequired} / {progress.totalRequired} LESSONS · {progress.percent}%
        </p>
      </div>
      {curriculum.map((entry) => (
        <div key={entry.section.id}>
          <p className="cu-sec">{entry.section.title}</p>
          {entry.publishedLessons.map((l) => {
            const done = completedSet.has(l.id);
            const current = l.id === lesson.id;
            return (
              <Link
                key={l.id}
                className={`cu-lesson${done ? " done" : ""}${current ? " current" : ""}`}
                href={`/learn/courses/${course.slug}/lessons/${l.slug}`}
                aria-current={current ? true : undefined}
              >
                <span className="tick">{done ? "✓" : ""}</span>
                {l.title}
                {!l.required && <span className="opt">OPTIONAL</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <LessonPlayerShell curriculumNav={curriculumNav}>
      <article className="lesson has-mobile-bar">
        <p className="ls-position">{positionLabel} — {course.title.toUpperCase()}</p>
        <h1 className="a-h1 learner-mt-8">{lesson.title}</h1>

        {embedUrl && (
          <div className="lesson-video">
            <iframe
              className="lesson-video-frame"
              src={embedUrl}
              title={`${lesson.title} — video`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        )}

        <div className="ls-body learner-mt-20">
          <ContentBlockRenderer blocks={blocks} />
        </div>

        {resources.length > 0 && (
          <section className="learner-mt-36" aria-label="Lesson resources">
            <p className="a-micro learner-mb-10">THIS LESSON&apos;S RESOURCES</p>
            <div className="resource-list">
              {resources.map((r) => (
                <a key={r.id} className="resource-row" href={`/api/course-resources/${r.id}`} download>
                  <span className="rr-ico" aria-hidden="true">▼</span>
                  <span className="rr-main">
                    <b>{r.title}</b>
                    <span>PDF · {(r.size / 1024).toFixed(0)} KB · INCLUDED WITH COURSE</span>
                  </span>
                  <span className="rr-dl">Download</span>
                </a>
              ))}
            </div>
          </section>
        )}

        <div className="ls-actions">
          {prev ? (
            <Link className="btn secondary learner-link" href={`/learn/courses/${course.slug}/lessons/${prev.slug}`}>
              ← Previous
            </Link>
          ) : (
            <Link className="btn secondary learner-link" href={`/learn/courses/${course.slug}`}>
              ← Course
            </Link>
          )}
          <CompleteButton
            key={lesson.id}
            enrollmentId={enrollment.id}
            lessonId={lesson.id}
            alreadyDone={completedSet.has(lesson.id)}
            continueHref={continueHref}
          />
          {next ? (
            <Link className="btn secondary learner-link" href={`/learn/courses/${course.slug}/lessons/${next.slug}`}>
              Next →
            </Link>
          ) : (
            <Link className="btn secondary learner-link" href={finishHref}>
              Finish →
            </Link>
          )}
        </div>

        <div className="ls-mobile-bar" role="region" aria-label="Lesson actions">
          {prev ? (
            <Link className="btn secondary learner-link" href={`/learn/courses/${course.slug}/lessons/${prev.slug}`} aria-label="Previous lesson">
              ←
            </Link>
          ) : (
            <Link className="btn secondary learner-link" href={`/learn/courses/${course.slug}`} aria-label="Back to course">
              ←
            </Link>
          )}
          <CompleteButton
            key={lesson.id}
            enrollmentId={enrollment.id}
            lessonId={lesson.id}
            alreadyDone={completedSet.has(lesson.id)}
            continueHref={continueHref}
          />
          {next ? (
            <Link className="btn secondary learner-link" href={`/learn/courses/${course.slug}/lessons/${next.slug}`} aria-label="Next lesson">
              Next →
            </Link>
          ) : (
            <Link className="btn secondary learner-link" href={finishHref} aria-label={progress.completed ? "Done — see completion" : "Done — back to course"}>
              Done →
            </Link>
          )}
        </div>
      </article>
    </LessonPlayerShell>
  );
}
