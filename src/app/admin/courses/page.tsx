import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { getAllAdminCourses, getCourseEnrollmentCounts } from "@/features/courses/service";
import { CoursesClient } from "./courses-client";

// Session-gated Studio route: render per request.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Courses · Studio | Decoded Hiring",
  description: "Real course management for the Decoded Hiring learning platform.",
};

export default async function AdminCoursesPage(props: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");

  const searchParams = await props.searchParams;
  const q = searchParams.q || "";
  const status =
    searchParams.status === "published" || searchParams.status === "archived" || searchParams.status === "draft"
      ? searchParams.status
      : "all";

  const courseList = await getAllAdminCourses({ search: q, status });
  // PERFORMANCE (review correction G): ONE grouped COUNT query for the whole
  // list — the previous per-course Promise.all was N round-trips per page view.
  const countsByCourse = await getCourseEnrollmentCounts(courseList.map((c) => c.id));
  const initialCourses = courseList.map((c) => ({ ...c, enrollmentCount: countsByCourse[c.id] ?? 0 }));

  return <CoursesClient initialCourses={initialCourses} initialQ={q} initialStatus={status} />;
}
