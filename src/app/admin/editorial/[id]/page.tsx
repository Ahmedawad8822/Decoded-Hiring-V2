import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { getDraft } from "@/features/editorial-ai/drafts/service";
import { DraftDetailClient } from "./page-client";

export const metadata = {
  title: "Draft · Studio | Decoded Hiring",
  description: "Editorial draft detail and review.",
};

export default async function DraftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");

  const { id } = await params;
  const draft = await getDraft(id);
  if (!draft) redirect("/admin/editorial");

  return <DraftDetailClient draft={draft} />;
}
