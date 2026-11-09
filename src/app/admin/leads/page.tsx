import { EmptyState, FilterChips, PageHeader, StatusPill, humanLabel, DataTable } from "../_ui";
import Link from "next/link";
import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/auth";
import { isLeadKind, isLeadStatus, listLeads } from "@/features/leads/admin";
import { LEAD_SUBMISSION_KINDS, LEAD_SUBMISSION_STATUSES } from "@/features/leads/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leads · Studio | Decoded Hiring",
  description: "Inbox of public form submissions.",
  robots: { index: false, follow: false },
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function href(status: string, kind: string | null, page: number): string {
  const qs = new URLSearchParams();
  qs.set("status", status);
  if (kind) qs.set("kind", kind);
  if (page > 1) qs.set("page", String(page));
  return `/admin/leads?${qs.toString()}`;
}

function consents(l: {
  privacyAcknowledged: boolean;
  researchAccepted: boolean;
  emailMarketing: boolean;
  whatsapp: boolean;
  calls: boolean;
}): string {
  const on = [
    l.privacyAcknowledged && "privacy",
    l.researchAccepted && "research",
    l.emailMarketing && "email",
    l.whatsapp && "whatsapp",
    l.calls && "calls",
  ].filter(Boolean);
  return on.length ? on.join(", ") : "none";
}

export default async function AdminLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const requestedStatus = first(params.status);
  // Default view is the NEW queue; "ALL" shows every status.
  const statusParam = requestedStatus === "ALL" ? "ALL" : isLeadStatus(requestedStatus) ? requestedStatus : "NEW";
  const requestedKind = first(params.kind);
  const kind = isLeadKind(requestedKind) ? requestedKind : null;
  const parsedPage = Number.parseInt(first(params.page) ?? "1", 10);
  const { leads, total, page, pageCount } = await listLeads({
    status: statusParam === "ALL" ? null : statusParam,
    kind,
    page: Number.isFinite(parsedPage) ? parsedPage : 1,
  });

  const [statusResults, kindResults] = await Promise.all([
    Promise.all([...LEAD_SUBMISSION_STATUSES, "ALL"].map(async value => [value, (await listLeads({ status: value === "ALL" ? null : value, kind, pageSize: 1 })).total] as const)),
    Promise.all(LEAD_SUBMISSION_KINDS.map(async value => [value, (await listLeads({ status: statusParam === "ALL" ? null : statusParam, kind: value, pageSize: 1 })).total] as const)),
  ]);
  const statusCounts = Object.fromEntries(statusResults);
  const kindCounts = Object.fromEntries(kindResults);

  return (
    <div >

      <PageHeader eyebrow="Business" title="Leads" description={`${total} ${total === 1 ? "conversation" : "conversations"} to explore. Find the people ready for their next step.`} />
      <FilterChips label="Filter by status" items={[...LEAD_SUBMISSION_STATUSES, "ALL"].map(value => ({ label: humanLabel(value), active: statusParam === value, href: href(value, kind, 1), count: statusCounts[value] }))} />
      <FilterChips label="Filter by kind" items={[{ label: "All kinds", active: kind === null, href: href(statusParam, null, 1) }, ...LEAD_SUBMISSION_KINDS.map(value => ({ label: humanLabel(value), active: kind === value, href: href(statusParam, value, 1), count: kindCounts[value] }))]} />

      <div className="table-wrap">
        <DataTable className="data">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Email</th>
              <th>Country</th>
              <th>Consents</th>
              <th>Source</th>
              <th>Status</th>
              <th>Created (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 ? (
              <tr>
                <td colSpan={8}><EmptyState icon="leads" title="You’re all caught up" action={<Link href="/admin/leads?status=ALL" className="btn secondary">View all leads</Link>}>No leads match these filters.</EmptyState></td>
              </tr>
            ) : (
              leads.map((l) => (
                <tr key={l.id}>
                  <td>{humanLabel(l.kind)}</td>
                  <td>
                    <Link href={`/admin/leads/${l.id}`}>{l.fullName}</Link>
                  </td>
                  <td>{l.email}</td>
                  <td>{l.countryCode}</td>
                  <td>{consents(l)}</td>
                  <td>{l.sourceRoute}</td>
                  <td><StatusPill status={l.status}>{humanLabel(l.status)}</StatusPill></td>
                  <td className="num">{l.createdAt.toISOString().replace("T", " ").slice(0, 19)}</td>
                </tr>
              ))
            )}
          </tbody>
        </DataTable>
      </div>

      <div className="s-row s-gap-16 s-margin-top-16 s-align-items-center" >
        {page > 1 ? <Link href={href(statusParam, kind, page - 1)}>Previous</Link> : <span />}
        <span>
          Page {page} of {pageCount}
        </span>
        {page < pageCount ? <Link href={href(statusParam, kind, page + 1)}>Next</Link> : <span />}
      </div>
    </div>
  );
}
