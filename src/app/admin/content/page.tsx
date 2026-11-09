import { requireAdminPage } from "@/lib/auth";
import { getAllAdminGuides } from "@/features/guides/service";
import { getAllAdminFieldNotes } from "@/features/field-notes/service";
import { ContentWorkspaceClient } from "./content-workspace-client";

export const metadata = {
  title: "Content · Studio | Decoded Hiring",
  description: "Real Guide and Field Notes publishing management.",
};

export default async function AdminContentPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const session = await requireAdminPage();

  const intent = (await searchParams).new;
  const [guides, fieldNotes] = await Promise.all([
    getAllAdminGuides(),
    getAllAdminFieldNotes(),
  ]);

  return (
    <ContentWorkspaceClient
      initialIntent={intent}
      initialGuides={guides}
      initialFieldNotes={fieldNotes}
      currentUser={session.user}
    />
  );
}
