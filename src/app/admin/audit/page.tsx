import { EmptyState, FilterChips, PageHeader, RelativeTime, humanLabel, DataTable } from "../_ui";
import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { AUDIT_ENTITY_TYPES, listAdminAudit } from "@/features/audit/service";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Audit log · Studio | Decoded Hiring",
  description: "Read-only trail of admin changes.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function href(entityType: string | null, page: number): string {
  const qs = new URLSearchParams();
  if (entityType) qs.set("entityType", entityType);
  if (page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return s ? `/admin/audit?${s}` : "/admin/audit";
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const requested = first(params.entityType);
  const entityType =
    requested && (AUDIT_ENTITY_TYPES as readonly string[]).includes(requested) ? requested : null;
  const parsedPage = Number.parseInt(first(params.page) ?? "1", 10);
  const { entries, total, page, pageCount } = await listAdminAudit({
    entityType,
    page: Number.isFinite(parsedPage) ? parsedPage : 1,
  });

  return (
    <div >
      <PageHeader eyebrow="Admin" title="Audit log" description={`A clear record of your Studio changes. ${total} ${total === 1 ? "entry" : "entries"}${entityType ? ` for ${humanLabel(entityType)}` : ""}.`} />
      <FilterChips label="Filter by entity type" items={[{ label: "All", href: href(null, 1), active: entityType === null }, ...AUDIT_ENTITY_TYPES.map(value => ({ label: humanLabel(value), href: href(value, 1), active: entityType === value }))]} />

      <div className="table-wrap">
        <DataTable className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={5}><EmptyState icon="audit" title="A clean slate">Your Studio changes will appear here.</EmptyState></td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id}>
                  <td className="num"><RelativeTime date={e.createdAt} now={new Date().getTime()} /></td>
                  <td>{e.actorEmail ?? e.actorId}</td>
                  <td>{humanLabel(e.action)}</td>
                  <td>
                    <div className="cell-main">{humanLabel(e.entityType)}</div>
                    <div className="cell-sub">{e.entityId}</div>
                  </td>
                  <td className="num">{e.details ?? ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </DataTable>
      </div>

      <div className="s-row s-gap-16 s-margin-top-16 s-align-items-center" >
        {page > 1 ? <Link href={href(entityType, page - 1)}>Previous</Link> : <span />}
        <span>
          Page {page} of {pageCount}
        </span>
        {page < pageCount ? <Link href={href(entityType, page + 1)}>Next</Link> : <span />}
      </div>
    </div>
  );
}
