import { requireAdminPage } from "@/lib/auth";
import { getAllMemory } from "@/features/editorial-ai/memory/service";
import { MemoryPageClient } from "./page-client";

// Auth-gated admin page — force-dynamic to avoid SSG-time D1 contention.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Editorial Memory · Studio | Decoded Hiring",
  description: "Manage editorial memory that guides AI generation.",
};

export default async function MemoryPage() {
  await requireAdminPage();
  const memory = await getAllMemory();
  return <MemoryPageClient initialMemory={memory} />;
}
