import { requireAdminPage } from "@/lib/auth";
import { getAllAdminCourses, getCourseEnrollmentCounts } from "@/features/courses/service";
import { CoursesClient } from "./courses-client";
import { getOffersForCourses } from "@/features/offers/service";

// Session-gated Studio route: render per request.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Courses · Studio | Decoded Hiring",
  description: "Real course management for the Decoded Hiring learning platform.",
};

export default async function AdminCoursesPage(props: {
  searchParams: Promise<{ q?: string; status?: string; new?: string }>;
}) {
  await requireAdminPage();
  const searchParams = await props.searchParams;
  const q = searchParams.q || "";
  const status =
    searchParams.status === "published" || searchParams.status === "archived" || searchParams.status === "draft"
      ? searchParams.status
      : "all";

  const courseList = await getAllAdminCourses({ search: q, status });
  // PERFORMANCE (review correction G): ONE grouped COUNT query for the whole
  // list — the previous per-course Promise.all was N round-trips per page view.
  const courseIds = courseList.map((c) => c.id);
  const [countsByCourse, offersByCourse] = await Promise.all([
    getCourseEnrollmentCounts(courseIds),
    getOffersForCourses(courseIds),
  ]);
  const initialCourses = courseList.map((course) => {
    const offer = offersByCourse.get(course.id) ?? null;
    return {
      ...course,
      enrollmentCount: countsByCourse[course.id] ?? 0,
      offerId: offer?.id ?? null,
      offerActive: offer?.active ?? null,
      effectiveAccessMode: offer?.accessMode ?? course.accessMode,
    };
  });

  return <CoursesClient startNew={searchParams.new === "course"} initialCourses={initialCourses} initialQ={q} initialStatus={status} />;
}
