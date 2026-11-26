import Link from "next/link";
import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth";
import {
  listPeople,
  parsePeoplePage,
  parsePeopleQuery,
  parsePeopleTag,
} from "@/features/people/service";
import { DataTable, EmptyState, PageHeader, RelativeTime } from "../_ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "People · Studio | Decoded Hiring",
  description: "Every learner in one place: tags, activity and their full story.",
  robots: { index: false, follow: false },
};

function listHref(q: string, tag: string, page?: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tag) params.set("tag", tag);
  if (page && page > 1) params.set("page", String(page));
  const qs = params.toString();
  return `/admin/people${qs ? `?${qs}` : ""}`;
}

function exportHref(q: string, tag: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tag) params.set("tag", tag);
  const qs = params.toString();
  return `/admin/people/export${qs ? `?${qs}` : ""}`;
}

function formatDateUTC(date: Date): string {
  return date.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

export default async function AdminPeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string; page?: string }>;
}) {
  await requireAdminPage();
  const query = await searchParams;
  const q = parsePeopleQuery(query.q);
  const tag = parsePeopleTag(query.tag);
  const page = parsePeoplePage(query.page);

  const { rows, hasNextPage } = await listPeople({ q, tag, page });

  return (
    <>
      <PageHeader
        eyebrow="Learning"
        title="People"
        description="Everyone learning with you — search, filter by tag, open a full profile."
      />

      <form method="get" className="filter-bar" role="search" aria-label="Search people">
        {tag && <input type="hidden" name="tag" value={tag} />}
        <input
          className="search"
          type="search"
          name="q"
          aria-label="Search people by name or email"
          placeholder="Name or email…"
          defaultValue={q}
          maxLength={100}
        />
        <button className="btn secondary small" type="submit">
          Search
        </button>
        {(q || tag) && (
          <Link className="btn ghost small" href="/admin/people">
            Clear
          </Link>
        )}
        {/* Plain anchor: a prefetching <Link> would hit the export route (and its audit write). */}
        <a className="btn secondary small" href={exportHref(q, tag)} download>
          Export CSV
        </a>
      </form>

      {tag && (
        <p className="s-text-sm s-margin-top-12">
          Tagged <b>{tag}</b>{" "}
          <Link href={listHref(q, "", undefined)} aria-label="Clear tag filter">
            × clear
          </Link>
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState icon="leads" title={tag ? `No one tagged ${tag}` : "No people yet"}>
          {tag || q ? "Try another search or clear the filters." : "Learners appear here once they sign up."}
        </EmptyState>
      ) : (
        <>
          <div className="table-scroll">
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Courses</th>
                  <th scope="col">Tags</th>
                  <th scope="col">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.userId}>
                    <td>
                      <Link href={`/admin/people/${row.userId}`} className="cell-main">
                        {row.name}
                      </Link>
                      <span className="cell-sub s-block">{row.email}</span>
                    </td>
                    <td>{formatDateUTC(row.joinedAt)}</td>
                    <td className="num">{row.enrollmentCount}</td>
                    <td>
                      {row.tags.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        row.tags.map((t) => (
                          <Link
                            key={t}
                            href={listHref(q, t, undefined)}
                            className="lifecycle"
                            aria-label={`Filter by tag ${t}`}
                          >
                            {t}
                          </Link>
                        ))
                      )}
                    </td>
                    <td>
                      <RelativeTime date={row.lastActivityAt} now={new Date().getTime()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>

          <div className="data-card-list">
            {rows.map((row) => (
              <div className="data-card" key={`card-${row.userId}`}>
                <div className="dc-head">
                  <Link href={`/admin/people/${row.userId}`} className="dc-title">
                    {row.name}
                  </Link>
                  <span className="a-micro">
                    {row.enrollmentCount} course{row.enrollmentCount === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="dc-meta">
                  <span>{row.email}</span>
                  <span>
                    Joined {formatDateUTC(row.joinedAt)} · Active{" "}
                    <RelativeTime date={row.lastActivityAt} now={new Date().getTime()} />
                  </span>
                  {row.tags.length > 0 && (
                    <span className="s-row s-gap-6 s-flex-wrap-wrap">
                      {row.tags.map((t) => (
                        <Link key={t} href={listHref(q, t, undefined)} className="lifecycle">
                          {t}
                        </Link>
                      ))}
                    </span>
                  )}
                </p>
              </div>
            ))}
          </div>

          <nav aria-label="People pages" className="s-row s-gap-12 s-margin-top-20">
            {page > 1 && <Link href={listHref(q, tag, page - 1)}>Previous</Link>}
            <span>Page {page}</span>
            {hasNextPage && <Link href={listHref(q, tag, page + 1)}>Next</Link>}
          </nav>
        </>
      )}
    </>
  );
}
