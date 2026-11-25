import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  listAllPeopleForExport,
  parsePeopleQuery,
  parsePeopleTag,
} from "@/features/people/service";
import { recordAdminAudit } from "@/features/audit/service";
import { buildCsv } from "@/lib/csv";
import { httpStatusFor, publicErrorMessage } from "@/lib/errors";

// Private admin data: never prerendered or cached.
export const dynamic = "force-dynamic";

function toIsoUTC(date: Date | null): string {
  return date ? date.toISOString().replace(/\.\d{3}Z$/, "Z") : "";
}

/**
 * Admin CSV export of the filtered People list. Same q/tag semantics as the
 * page, capped at PEOPLE_EXPORT_MAX_ROWS rows in one query. Private data:
 * private + no-store caching, one audit row per export (tag filter + row
 * count only — never the search text, which may contain an email).
 */
export async function GET(_request: Request) {
  try {
    const session = await requireAdmin();
    const url = new URL(_request.url);
    const q = parsePeopleQuery(url.searchParams.get("q"));
    const tag = parsePeopleTag(url.searchParams.get("tag"));

    const rows = await listAllPeopleForExport({ q, tag });

    await recordAdminAudit({
      actorId: session.user.id,
      action: "people.export",
      entityType: "person",
      entityId: "all",
      details: { filter: tag || "all", rows: rows.length },
    });

    const csv = buildCsv(
      ["name", "email", "joined_at", "enrollment_count", "tags", "last_activity_at"],
      rows.map((row) => [
        row.name,
        row.email,
        toIsoUTC(row.joinedAt),
        row.enrollmentCount,
        row.tags.join(";"),
        toIsoUTC(row.lastActivityAt),
      ]),
    );

    const day = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="people-${day}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: publicErrorMessage(error, "Export failed") },
      { status: httpStatusFor(error) },
    );
  }
}
