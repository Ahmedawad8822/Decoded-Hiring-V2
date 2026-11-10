import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { getAdminCourseById } from "@/features/courses/service";
import { CERTIFICATES_PAGE_SIZE, listCourseCertificates } from "@/features/certificates/service";
import { PageHeader } from "../../../_ui";
import { CertificatesClient } from "./certificates-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Certificates · Studio | Decoded Hiring" };

export default async function CourseCertificatesPage({ params, searchParams }: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAdminPage();
  const { courseId } = await params;
  const requested = Number((await searchParams).page);
  const page = Number.isSafeInteger(requested) ? Math.max(1, Math.min(10000, requested)) : 1;
  const course = await getAdminCourseById(courseId);
  if (!course) notFound();
  const rows = await listCourseCertificates(courseId, page);
  return <>
    <PageHeader eyebrow="Learning" title="Certificates" description={course.title} />
    <Link href="/admin/courses">← Courses</Link>
    <CertificatesClient certificates={rows.slice(0, CERTIFICATES_PAGE_SIZE)} />
    <nav aria-label="Certificate pages" className="s-row s-gap-12 s-margin-top-20">
      {page > 1 && <Link href={`?page=${page - 1}`}>Previous</Link>}
      <span>Page {page}</span>
      {rows.length > CERTIFICATES_PAGE_SIZE && <Link href={`?page=${page + 1}`}>Next</Link>}
    </nav>
  </>;
}
