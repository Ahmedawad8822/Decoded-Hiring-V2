import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { getAllAdminCourses, getCourseEnrollmentCount } from "@/features/courses/service";
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
  const counts = await Promise.all(courseList.map((c) => getCourseEnrollmentCount(c.id)));
  const initialCourses = courseList.map((c, i) => ({ ...c, enrollmentCount: counts[i] }));

  return <CoursesClient initialCourses={initialCourses} initialQ={q} initialStatus={status} />;
}
