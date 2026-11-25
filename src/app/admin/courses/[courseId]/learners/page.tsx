import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { getAdminCourseById } from "@/features/courses/service";
import {
  parseLearnerFilter,
  parseLearnerPage,
  parseLearnerQuery,
  getCourseLearnerSummary,
  listCourseLearners,
  type CourseLearnerRow,
  type LearnerFilter,
} from "@/features/learners/service";
import { parsePeopleTag } from "@/features/people/service";
import { DataTable, EmptyState, PageHeader, RelativeTime } from "../../../_ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Learners · Studio | Decoded Hiring" };

const FILTER_LABELS: Record<LearnerFilter, string> = {
  all: "All",
  "not-started": "Not started",
  "in-progress": "In progress",
  stuck: "Stuck",
  completed: "Completed",
  left: "Left",
};

const FILTER_ORDER: LearnerFilter[] = [
  "all",
  "not-started",
  "in-progress",
  "stuck",
  "completed",
  "left",
];

const EMPTY_TITLES: Record<LearnerFilter, string> = {
  all: "No learners yet",
  "not-started": "Everyone has started",
  "in-progress": "No one is mid-course",
  stuck: "No one is stuck. Nice.",
  completed: "No completions yet",
  left: "No one has left",
};

function displayStatus(row: CourseLearnerRow): { label: string; className: string } {
  if (row.status === "cancelled") return { label: "Left", className: "left" };
  if (row.status === "completed") return { label: "Completed", className: "completed" };
  if (row.isStuck) return { label: "Stuck", className: "stuck" };
  return { label: "Active", className: "active" };
}

function chipHref(courseId: string, filter: LearnerFilter, q: string, tag: string): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (q) params.set("q", q);
  if (tag) params.set("tag", tag);
  const qs = params.toString();
  return `/admin/courses/${courseId}/learners${qs ? `?${qs}` : ""}`;
}

function pageHref(courseId: string, filter: LearnerFilter, q: string, tag: string, page: number): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (q) params.set("q", q);
  if (tag) params.set("tag", tag);
  params.set("page", String(page));
  return `/admin/courses/${courseId}/learners?${params.toString()}`;
}

function exportHref(courseId: string, filter: LearnerFilter, q: string, tag: string): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (q) params.set("q", q);
  if (tag) params.set("tag", tag);
  const qs = params.toString();
  return `/admin/courses/${courseId}/learners/export${qs ? `?${qs}` : ""}`;
}

function formatDateUTC(date: Date): string {
  return date.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

export default async function CourseLearnersPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ filter?: string; q?: string; page?: string; tag?: string }>;
}) {
  await requireAdminPage();
  const { courseId } = await params;
  const query = await searchParams;
  const filter = parseLearnerFilter(query.filter);
  const q = parseLearnerQuery(query.q);
  const page = parseLearnerPage(query.page);
  // Batch I: extra EXISTS filter over learner_tags (tag chips link here from
  // the People list; the profile links back with the learner's email as q).
  const tag = parsePeopleTag(query.tag);

  const course = await getAdminCourseById(courseId);
  if (!course) notFound();

  const [{ rows, hasNextPage }, summary] = await Promise.all([
    listCourseLearners(courseId, { filter, page, q, tag }),
    getCourseLearnerSummary(courseId),
  ]);

  const counts: Record<LearnerFilter, number> = {
    all: summary.all,
    "not-started": summary.notStarted,
    "in-progress": summary.inProgress,
    stuck: summary.stuck,
    completed: summary.completed,
    left: summary.left,
  };

  return (
    <>
      <PageHeader eyebrow="Learning" title="Learners" description={course.title} />
      <Link href="/admin/courses">← Courses</Link>

      <nav aria-label="Learner filters" className="filter-chips">
        {FILTER_ORDER.map((f) => (
          <Link
            key={f}
            href={chipHref(courseId, f, q, tag)}
            aria-current={filter === f ? "page" : undefined}
          >
            {FILTER_LABELS[f]}
            <span>{counts[f]}</span>
          </Link>
        ))}
      </nav>

      {tag && (
        <p className="s-text-sm s-margin-top-12">
          Tagged <b>{tag}</b>{" "}
          <Link href={chipHref(courseId, filter, q, "")} aria-label="Clear tag filter">
            × clear
          </Link>
        </p>
      )}

      <form method="get" className="filter-bar" role="search" aria-label="Search learners">
        {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
        {tag && <input type="hidden" name="tag" value={tag} />}
        <input
          className="search"
          type="search"
          name="q"
          aria-label="Search learners by name or email"
          placeholder="Name or email…"
          defaultValue={q}
          maxLength={100}
        />
        <button className="btn secondary small" type="submit">
          Search
        </button>
        {(q || filter !== "all" || tag) && (
          <Link className="btn ghost small" href={`/admin/courses/${courseId}/learners`}>
            Clear
          </Link>
        )}
        {/* Plain anchor: a prefetching <Link> would hit the export route (and its audit write). */}
        <a className="btn secondary small" href={exportHref(courseId, filter, q, tag)} download>
          Export CSV
        </a>
      </form>

      {rows.length === 0 ? (
        <EmptyState icon="leads" title={EMPTY_TITLES[filter]}>
          {filter === "all"
            ? "Share the course link to welcome the first learner."
            : "Try another filter or search."}
        </EmptyState>
      ) : (
        <>
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Learner</th>
                  <th scope="col">Progress</th>
                  <th scope="col">Enrolled</th>
                  <th scope="col">Last activity</th>
                  <th scope="col">Status</th>
                  <th scope="col">Certificate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const badge = displayStatus(row);
                  return (
                      <tr key={row.enrollmentId}>
                        <td>
                          <Link href={`/admin/people/${row.userId}`} className="cell-main">
                            {row.name}
                          </Link>
                          <span className="cell-sub s-block">{row.email}</span>
                        </td>
                      <td>
                        <span
                          className="learner-progress"
                          role="img"
                          aria-label={`${row.percent}% complete`}
                        >
                          <i style={{ width: `${row.percent}%` }} />
                        </span>
                        <span className="cell-sub s-block">
                          {row.completedRequired} of {row.totalRequired} · {row.percent}%
                        </span>
                      </td>
                      <td>{formatDateUTC(row.enrolledAt)}</td>
                      <td>
                        <RelativeTime date={row.lastActivityAt} now={new Date().getTime()} />
                      </td>
                      <td>
                        <span className={`lifecycle ${badge.className}`}>{badge.label}</span>
                      </td>
                      <td>{row.hasCertificate ? <span aria-label="Certificate issued">✓</span> : <span aria-label="No certificate">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          </div>

          <div className="data-card-list">
            {rows.map((row) => {
              const badge = displayStatus(row);
              return (
                <div className="data-card" key={`card-${row.enrollmentId}`}>
                  <div className="dc-head">
                    <Link href={`/admin/people/${row.userId}`} className="dc-title">
                      {row.name}
                    </Link>
                    <span className={`lifecycle ${badge.className}`}>{badge.label}</span>
                  </div>
                  <p className="dc-meta">
                    <span>{row.email}</span>
                    <span>
                      {row.completedRequired} of {row.totalRequired} · {row.percent}%
                    </span>
                    <span>
                      Enrolled {formatDateUTC(row.enrolledAt)} · Active{" "}
                      <RelativeTime date={row.lastActivityAt} now={new Date().getTime()} />
                    </span>
                    {row.hasCertificate && <span>Certificate ✓</span>}
                  </p>
                </div>
              );
            })}
          </div>

          <nav aria-label="Learner pages" className="s-row s-gap-12 s-margin-top-20">
            {page > 1 && <Link href={pageHref(courseId, filter, q, tag, page - 1)}>Previous</Link>}
            <span>Page {page}</span>
            {hasNextPage && <Link href={pageHref(courseId, filter, q, tag, page + 1)}>Next</Link>}
          </nav>
        </>
      )}
    </>
  );
}
