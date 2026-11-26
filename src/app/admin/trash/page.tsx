import { requireAdminPage } from "@/lib/auth";
import { listTrash } from "@/features/trash/service";
import { TrashClient } from "./trash-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Trash · Studio | Decoded Hiring",
  description: "Recover or permanently delete trashed guides, field notes, courses and lessons.",
};

export default async function AdminTrashPage() {
  await requireAdminPage();
  const items = await listTrash();
  return <TrashClient initialItems={items} />;
}
