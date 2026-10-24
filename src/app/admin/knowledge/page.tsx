import { requireAdminPage } from "@/lib/auth";
import { listKnowledgeSources } from "@/features/editorial-ai/knowledge/service";
import { KnowledgePageClient } from "./page-client";

// Auth-gated admin page — force-dynamic to avoid SSG-time D1 contention.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Knowledge · Studio | Decoded Hiring",
  description: "Manage the editorial knowledge library.",
};

export default async function KnowledgePage() {
  const session = await requireAdminPage();
  const sources = await listKnowledgeSources();

  return <KnowledgePageClient initialSources={sources} user={session.user} />;
}
