import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { listKnowledgeSources } from "@/features/editorial-ai/knowledge/service";
import { NewDraftClient } from "./page-client";

export const metadata = {
  title: "New Draft · Studio | Decoded Hiring",
  description: "Generate a new editorial draft with AI.",
};

export default async function NewDraftPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");

  const sources = await listKnowledgeSources();

  return <NewDraftClient user={session.user} sources={sources} />;
}
