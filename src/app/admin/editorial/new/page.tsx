import { requireAdminPage } from "@/lib/auth";
import { listKnowledgeSources } from "@/features/editorial-ai/knowledge/service";
import { NewDraftClient } from "./page-client";

export const metadata = {
  title: "New Draft · Studio | Decoded Hiring",
  description: "Generate a new editorial draft with AI.",
};

export default async function NewDraftPage() {
  const session = await requireAdminPage();
  const sources = await listKnowledgeSources();

  return <NewDraftClient user={session.user} sources={sources} />;
}
