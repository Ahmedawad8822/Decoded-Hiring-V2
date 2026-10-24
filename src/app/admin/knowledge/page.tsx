import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { listKnowledgeSources } from "@/features/editorial-ai/knowledge/service";
import { KnowledgePageClient } from "./page-client";

// Auth-gated admin page — force-dynamic to avoid SSG-time D1 contention.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Knowledge · Studio | Decoded Hiring",
  description: "Manage the editorial knowledge library.",
};

export default async function KnowledgePage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");

  const sources = await listKnowledgeSources();

  return <KnowledgePageClient initialSources={sources} user={session.user} />;
}
