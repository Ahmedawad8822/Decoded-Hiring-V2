import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { getDraft } from "@/features/editorial-ai/drafts/service";
import { DraftDetailClient } from "./page-client";

export const metadata = {
  title: "Draft · Studio | Decoded Hiring",
  description: "Editorial draft detail and review.",
};

export default async function DraftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  const draft = await getDraft(id);
  if (!draft) redirect("/admin/editorial");

  return <DraftDetailClient draft={draft} />;
}
