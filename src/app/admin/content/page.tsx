import { requireAdminPage } from "@/lib/auth";
import { getAllAdminGuides } from "@/features/guides/service";
import { getAllAdminFieldNotes } from "@/features/field-notes/service";
import { getAllAdminPages } from "@/features/pages/service";
import { ContentWorkspaceClient } from "./content-workspace-client";

export const metadata = {
  title: "Content · Studio | Decoded Hiring",
  description: "Real Guide, Field Notes and Page publishing management.",
};

export default async function AdminContentPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const session = await requireAdminPage();

  const intent = (await searchParams).new;
  const [guides, fieldNotes, pages] = await Promise.all([
    getAllAdminGuides(),
    getAllAdminFieldNotes(),
    getAllAdminPages(),
  ]);

  return (
    <ContentWorkspaceClient
      initialIntent={intent}
      initialGuides={guides}
      initialFieldNotes={fieldNotes}
      initialPages={pages}
      currentUser={session.user}
    />
  );
}
