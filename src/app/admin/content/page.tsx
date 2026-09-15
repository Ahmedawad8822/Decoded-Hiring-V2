import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { getAllAdminGuides } from "@/features/guides/service";
import { getAllAdminFieldNotes } from "@/features/field-notes/service";
import { ContentWorkspaceClient } from "./content-workspace-client";

export const metadata = {
  title: "Content · Studio | Decoded Hiring",
  description: "Real Guide and Field Notes publishing management.",
};

export default async function AdminContentPage() {
  const session = await getServerSession();

  // Server-side authorization gate per Domain 1
  if (!session?.user) {
    redirect("/admin/login");
  }

  const role = (session.user as { role?: string }).role;
  if (role !== "admin") {
    redirect("/admin/login?error=forbidden");
  }

  const [guides, fieldNotes] = await Promise.all([
    getAllAdminGuides(),
    getAllAdminFieldNotes(),
  ]);

  return (
    <ContentWorkspaceClient
      initialGuides={guides}
      initialFieldNotes={fieldNotes}
      currentUser={session.user}
    />
  );
}
