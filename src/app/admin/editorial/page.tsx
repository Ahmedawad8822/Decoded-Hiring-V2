import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { listDrafts } from "@/features/editorial-ai/drafts/service";
import { EditorialListClient } from "./page-client";
import type { DraftStatus } from "@/features/editorial-ai/drafts/types";

export const metadata = {
  title: "Editorial · Studio | Decoded Hiring",
  description: "Review and publish AI-generated editorial drafts.",
};

export default async function EditorialPage({ searchParams }: { searchParams: Promise<{ status?: string; type?: string }> }) {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");

  const { status, type } = await searchParams;
  const drafts = await listDrafts({
    status: status as DraftStatus | undefined,
    contentType: type as "GUIDE" | "FIELD_NOTE" | undefined,
  });

  return <EditorialListClient initialDrafts={drafts} />;
}
