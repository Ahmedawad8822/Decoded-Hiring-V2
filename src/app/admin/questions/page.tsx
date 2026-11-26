import { EmptyState, FilterChips, PageHeader, StatusPill, humanLabel, DataTable } from "../_ui";
import Link from "next/link";
import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth";
import {
  isLessonQuestionStatus,
  LESSON_QUESTION_STATUSES,
} from "@/features/lesson-questions/types";
import { listAdminQuestions, listQuestionCourses } from "@/features/lesson-questions/service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Questions · Studio | Decoded Hiring",
  description: "Inbox of private learner questions per lesson.",
  robots: { index: false, follow: false },
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function href(status: string, courseId: string | null, page: number): string {
  const qs = new URLSearchParams();
  qs.set("status", status);
  if (courseId) qs.set("courseId", courseId);
  if (page > 1) qs.set("page", String(page));
  return `/admin/questions?${qs.toString()}`;
}

function excerpt(body: string): string {
  return body.length > 120 ? `${body.slice(0, 120)}…` : body;
}

function ts(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export default async function AdminQuestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const requestedStatus = first(params.status);
  // Default view is the OPEN queue; "ALL" shows every status.
  const statusParam =
    requestedStatus === "ALL" ? "ALL" : isLessonQuestionStatus(requestedStatus) ? requestedStatus : "open";
  const courseId = first(params.courseId) ?? null;
  const parsedPage = Number.parseInt(first(params.page) ?? "1", 10);

  const [{ rows, total, page, pageCount }, questionCourses] = await Promise.all([
    listAdminQuestions({
      status: statusParam === "ALL" ? null : statusParam,
      courseId,
      page: Number.isFinite(parsedPage) ? parsedPage : 1,
    }),
    listQuestionCourses(),
  ]);
  const courseKnown = courseId === null || questionCourses.some((c) => c.id === courseId);
  const visibleRows = courseKnown ? rows : [];
  const visibleTotal = courseKnown ? total : 0;

  const statusCounts = Object.fromEntries(
    await Promise.all(
      [...LESSON_QUESTION_STATUSES, "ALL"].map(
        async (value) =>
          [
            value,
            (
              await listAdminQuestions({
                status: value === "ALL" ? null : value,
                courseId: courseKnown ? courseId : null,
                pageSize: 1,
              })
            ).total,
          ] as const,
      ),
    ),
  );

  return (
    <div>
      <PageHeader
        eyebrow="Courses"
        title="Questions"
        description={`${visibleTotal} ${visibleTotal === 1 ? "question" : "questions"} to answer. Private by default — only published answers appear on the lesson.`}
      />
      <FilterChips
        label="Filter by status"
        items={[...LESSON_QUESTION_STATUSES, "ALL"].map((value) => ({
          label: humanLabel(value),
          active: statusParam === value,
          href: href(value, courseKnown ? courseId : null, 1),
          count: statusCounts[value],
        }))}
      />

      {questionCourses.length > 0 && (
        <form method="get" action="/admin/questions" className="s-margin-top-8">
          <input type="hidden" name="status" value={statusParam} />
          <label className="s-text-sm" htmlFor="question-course-filter">
            Course{" "}
          </label>
          <select id="question-course-filter" name="courseId" defaultValue={courseKnown ? (courseId ?? "") : ""}>
            <option value="">All courses</option>
            {questionCourses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.title}
              </option>
            ))}
          </select>{" "}
          <button type="submit" className="btn secondary small">
            Filter
          </button>
        </form>
      )}

      <div className="table-wrap">
        <DataTable className="data">
          <thead>
            <tr>
              <th>Question</th>
              <th>Learner</th>
              <th>Course</th>
              <th>Lesson</th>
              <th>Status</th>
              <th>Public</th>
              <th>Asked (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    icon="inbox"
                    title="You’re all caught up"
                    action={
                      <Link href="/admin/questions?status=ALL" className="btn secondary">
                        View all questions
                      </Link>
                    }
                  >
                    No questions match these filters.
                  </EmptyState>
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/admin/questions/${row.id}`}>{excerpt(row.body)}</Link>
                  </td>
                  <td>
                    <Link href={`/admin/people/${row.learnerId}`}>{row.learnerName}</Link>
                  </td>
                  <td>{row.courseTitle}</td>
                  <td>{row.lessonTitle}</td>
                  <td>
                    <StatusPill status={row.status}>{humanLabel(row.status)}</StatusPill>
                  </td>
                  <td>{row.isPublic ? "Yes" : "No"}</td>
                  <td className="num">{ts(row.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </DataTable>
      </div>

      <div className="s-row s-gap-16 s-margin-top-16 s-align-items-center">
        {page > 1 ? <Link href={href(statusParam, courseKnown ? courseId : null, page - 1)}>Previous</Link> : <span />}
        <span>
          Page {page} of {pageCount}
        </span>
        {page < pageCount ? (
          <Link href={href(statusParam, courseKnown ? courseId : null, page + 1)}>Next</Link>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
