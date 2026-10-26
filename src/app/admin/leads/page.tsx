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

  return (
    <div style={{ padding: "24px 28px" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Leads</h1>
      <p style={{ color: "var(--muted)", marginBottom: 16 }}>
        {total} {total === 1 ? "lead" : "leads"} ({statusParam === "ALL" ? "all statuses" : statusParam}
        {kind ? `, ${kind}` : ""}), newest first.
      </p>

      <nav aria-label="Filter by status" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        {[...LEAD_SUBMISSION_STATUSES, "ALL"].map((s) => (
          <Link key={s} href={href(s, kind, 1)} aria-current={statusParam === s ? "page" : undefined}>
            {statusParam === s ? <b>{s}</b> : s}
          </Link>
        ))}
      </nav>
      <nav aria-label="Filter by kind" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <Link href={href(statusParam, null, 1)} aria-current={kind === null ? "page" : undefined}>
          {kind === null ? <b>All kinds</b> : "All kinds"}
        </Link>
        {LEAD_SUBMISSION_KINDS.map((k) => (
          <Link key={k} href={href(statusParam, k, 1)} aria-current={kind === k ? "page" : undefined}>
            {kind === k ? <b>{k}</b> : k}
          </Link>
        ))}
      </nav>

      <div className="table-wrap">
        <table className="data">
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
                <td colSpan={8}>No leads match these filters.</td>
              </tr>
            ) : (
              leads.map((l) => (
                <tr key={l.id}>
                  <td>{l.kind}</td>
                  <td>
                    <Link href={`/admin/leads/${l.id}`}>{l.fullName}</Link>
                  </td>
                  <td>{l.email}</td>
                  <td>{l.countryCode}</td>
                  <td>{consents(l)}</td>
                  <td>{l.sourceRoute}</td>
                  <td>{l.status}</td>
                  <td className="num">{l.createdAt.toISOString().replace("T", " ").slice(0, 19)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 16, alignItems: "center" }}>
        {page > 1 ? <Link href={href(statusParam, kind, page - 1)}>Previous</Link> : <span />}
        <span>
          Page {page} of {pageCount}
        </span>
        {page < pageCount ? <Link href={href(statusParam, kind, page + 1)}>Next</Link> : <span />}
      </div>
    </div>
  );
}
