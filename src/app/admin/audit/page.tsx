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
    <div style={{ padding: "24px 28px" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Audit log</h1>
      <p style={{ color: "var(--muted)", marginBottom: 16 }}>
        Read-only trail of admin changes. {total} {total === 1 ? "entry" : "entries"}
        {entityType ? ` for ${entityType}` : ""}.
      </p>

      <nav aria-label="Filter by entity type" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <Link href={href(null, 1)} aria-current={entityType === null ? "page" : undefined}>
          {entityType === null ? <b>All</b> : "All"}
        </Link>
        {AUDIT_ENTITY_TYPES.map((t) => (
          <Link key={t} href={href(t, 1)} aria-current={entityType === t ? "page" : undefined}>
            {entityType === t ? <b>{t}</b> : t}
          </Link>
        ))}
      </nav>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When (UTC)</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={5}>No audit entries yet.</td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id}>
                  <td className="num">{e.createdAt.toISOString().replace("T", " ").slice(0, 19)}</td>
                  <td>{e.actorEmail ?? e.actorId}</td>
                  <td>{e.action}</td>
                  <td>
                    <div className="cell-main">{e.entityType}</div>
                    <div className="cell-sub">{e.entityId}</div>
                  </td>
                  <td className="num">{e.details ?? ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 16, alignItems: "center" }}>
        {page > 1 ? <Link href={href(entityType, page - 1)}>Previous</Link> : <span />}
        <span>
          Page {page} of {pageCount}
        </span>
        {page < pageCount ? <Link href={href(entityType, page + 1)}>Next</Link> : <span />}
      </div>
    </div>
  );
}
