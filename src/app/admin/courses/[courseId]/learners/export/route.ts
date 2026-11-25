import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getAdminCourseById } from "@/features/courses/service";
import {
  listAllCourseLearnersForExport,
  parseLearnerFilter,
  parseLearnerQuery,
} from "@/features/learners/service";
import { parsePeopleTag } from "@/features/people/service";
import { recordAdminAudit } from "@/features/audit/service";
import { buildCsv } from "@/lib/csv";
import { httpStatusFor, publicErrorMessage } from "@/lib/errors";

// Private admin data: never prerendered or cached.
export const dynamic = "force-dynamic";

function toIsoUTC(date: Date | null): string {
  return date ? date.toISOString().replace(/\.\d{3}Z$/, "Z") : "";
}

function slugForFilename(slug: string): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "course";
}

/**
 * Admin CSV export of a course's learners. Same filter/q/tag semantics as
 * the Learners tab, capped at LEARNERS_EXPORT_MAX_ROWS rows in one query.
 * Private data: private + no-store caching, one audit row per export
 * (filter + row count only — never emails or the search text).
 */
export async function GET(
  _request: Request,
  props: { params: Promise<{ courseId: string }> },
) {
  try {
    const session = await requireAdmin();
    const { courseId } = await props.params;
    const url = new URL(_request.url);
    const filter = parseLearnerFilter(url.searchParams.get("filter"));
    const q = parseLearnerQuery(url.searchParams.get("q"));
    const tag = parsePeopleTag(url.searchParams.get("tag"));

    const course = await getAdminCourseById(courseId);
    if (!course) {
      return NextResponse.json({ error: "Course not found" }, { status: 404 });
    }

    const rows = await listAllCourseLearnersForExport(courseId, { filter, q, tag });

    await recordAdminAudit({
      actorId: session.user.id,
      action: "learners.export",
      entityType: "course",
      entityId: courseId,
      details: { filter, ...(tag ? { tag } : {}), rows: rows.length },
    });

    const csv = buildCsv(
      [
        "name",
        "email",
        "status",
        "progress_percent",
        "lessons_completed",
        "lessons_required",
        "enrolled_at",
        "last_activity_at",
        "completed_at",
        "left_at",
        "certificate",
      ],
      rows.map((row) => [
        row.name,
        row.email,
        row.status,
        row.percent,
        row.completedRequired,
        row.totalRequired,
        toIsoUTC(row.enrolledAt),
        toIsoUTC(row.lastActivityAt),
        toIsoUTC(row.completedAt),
        toIsoUTC(row.cancelledAt),
        row.hasCertificate ? "yes" : "no",
      ]),
    );

    const day = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="learners-${slugForFilename(course.slug)}-${day}.csv"`,
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
