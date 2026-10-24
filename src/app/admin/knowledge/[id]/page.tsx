import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { getKnowledgeSource } from "@/features/editorial-ai/knowledge/service";
import { getChunksForSource } from "@/features/editorial-ai/knowledge/retrieval";
import { KnowledgeDetailClient } from "./page-client";

export const metadata = {
  title: "Source · Studio | Decoded Hiring",
  description: "Knowledge source detail.",
};

export default async function KnowledgeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");

  const { id } = await params;
  const source = await getKnowledgeSource(id);
  if (!source) redirect("/admin/knowledge");

  const chunks = source.status === "READY" ? await getChunksForSource(id) : [];

  return <KnowledgeDetailClient source={source} chunks={chunks} />;
}
