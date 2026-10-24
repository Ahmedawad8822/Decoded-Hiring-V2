import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { getKnowledgeSource } from "@/features/editorial-ai/knowledge/service";
import { getChunksForSource } from "@/features/editorial-ai/knowledge/retrieval";
import { KnowledgeDetailClient } from "./page-client";

export const metadata = {
  title: "Source · Studio | Decoded Hiring",
  description: "Knowledge source detail.",
};

export default async function KnowledgeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  const source = await getKnowledgeSource(id);
  if (!source) redirect("/admin/knowledge");

  const chunks = source.status === "READY" ? await getChunksForSource(id) : [];

  return <KnowledgeDetailClient source={source} chunks={chunks} />;
}
