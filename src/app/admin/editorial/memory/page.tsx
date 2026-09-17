import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { getAllMemory } from "@/features/editorial-ai/memory/service";
import { MemoryPageClient } from "./page-client";

export const metadata = {
  title: "Editorial Memory · Studio | Decoded Hiring",
  description: "Manage editorial memory that guides AI generation.",
};

export default async function MemoryPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/admin/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "admin") redirect("/admin/login?error=forbidden");

  const memory = await getAllMemory();
  return <MemoryPageClient initialMemory={memory} />;
}
